import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

import { AcceptanceCatalogSchema, type AcceptanceCatalog } from '../domain/acceptance-catalog.js';
import { DecisionRegisterSchema } from '../domain/decision-register.js';
import { FactRegisterSchema } from '../domain/fact-register.js';
import { completedArtifactPath } from '../domain/handoff.js';
import { formatSchemaDiagnostics } from '../domain/schema-diagnostics.js';
import { TaskSchema, type Task, type TaskNode } from '../domain/task.js';
import { TaskStore } from './task-store.js';
import { deriveTaskStatus } from './task-state-machine.js';
import { ProjectTestProfiles, VerificationProfileRefSchema } from './project-test-profiles.js';

const unitIdPattern = /^[a-z][a-z0-9-]{0,40}$/;

const WorkUnitSchema = z.object({
  id: z.string().regex(unitIdPattern, '工作单元 ID 格式无效'),
  title: z.string().min(1),
  goal: z.string().min(1),
  acceptanceRefs: z.array(z.string().min(1)).min(1),
  factRefs: z.array(z.string().regex(/^FACT-[A-Z0-9-]+$/, '事实引用格式无效')).min(1),
  decisionRefs: z.array(z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效')).default([]),
  steps: z.array(z.string().min(1)).min(1),
  verification: z.array(VerificationProfileRefSchema).min(1),
  blockedBy: z.array(z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效')).default([]),
  dependsOn: z.array(z.string().regex(unitIdPattern, '依赖工作单元 ID 格式无效')).default([]),
}).strict();

const AcceptanceCoverageSchema = z.object({
  acceptanceId: z.string().regex(/^AC-\d{2,}$/, '验收项 ID 格式无效'),
  disposition: z.enum(['implement', 'waiting_external']),
  workUnitIds: z.array(z.string().regex(unitIdPattern, '工作单元 ID 格式无效')).default([]),
  decisionId: z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效').optional(),
}).strict();

export const WorkBreakdownSchema = z.object({
  schemaVersion: z.literal('aiw.work-breakdown/v2'),
  units: z.array(WorkUnitSchema).min(1),
  acceptanceCoverage: z.array(AcceptanceCoverageSchema).min(1),
}).strict().superRefine((breakdown, context) => {
  const ids = new Set(breakdown.units.map((unit) => unit.id));
  if (ids.size !== breakdown.units.length) {
    context.addIssue({ code: 'custom', path: ['units'], message: '工作单元 ID 必须唯一' });
  }
  for (const [index, unit] of breakdown.units.entries()) {
    for (const dependency of unit.dependsOn) {
      if (!ids.has(dependency) || dependency === unit.id) {
        context.addIssue({ code: 'custom', path: ['units', index, 'dependsOn'], message: '工作单元依赖必须指向其他已声明单元' });
      }
    }
    if (new Set(unit.factRefs).size !== unit.factRefs.length) {
      context.addIssue({ code: 'custom', path: ['units', index, 'factRefs'], message: '工作单元引用的事实 ID 必须唯一' });
    }
    if (new Set(unit.decisionRefs).size !== unit.decisionRefs.length) {
      context.addIssue({ code: 'custom', path: ['units', index, 'decisionRefs'], message: '工作单元引用的决策 ID 必须唯一' });
    }
    if (unit.blockedBy.some((id) => !unit.decisionRefs.includes(id))) {
      context.addIssue({ code: 'custom', path: ['units', index, 'decisionRefs'], message: 'blockedBy 中的决策必须同时出现在 decisionRefs' });
    }
    if (new Set(unit.verification.map((item) => `${item.profile}:${item.targets.join(',')}`)).size !== unit.verification.length) {
      context.addIssue({ code: 'custom', path: ['units', index, 'verification'], message: '工作单元测试能力引用不能重复' });
    }
  }
  if (hasCycle(breakdown.units.map((unit) => ({ id: unit.id, dependsOn: unit.dependsOn })))) {
    context.addIssue({ code: 'custom', path: ['units'], message: '工作单元依赖存在环' });
  }
  const coverageIds = new Set(breakdown.acceptanceCoverage.map((item) => item.acceptanceId));
  if (coverageIds.size !== breakdown.acceptanceCoverage.length) {
    context.addIssue({ code: 'custom', path: ['acceptanceCoverage'], message: '验收覆盖声明不能重复同一验收项' });
  }
  for (const [index, coverage] of breakdown.acceptanceCoverage.entries()) {
    const unitIds = new Set(coverage.workUnitIds);
    if (unitIds.size !== coverage.workUnitIds.length || coverage.workUnitIds.some((id) => !ids.has(id))) {
      context.addIssue({ code: 'custom', path: ['acceptanceCoverage', index, 'workUnitIds'], message: '验收覆盖必须引用已声明且唯一的工作单元' });
    }
    if (['implement', 'waiting_external'].includes(coverage.disposition) && coverage.workUnitIds.length !== 1) {
      context.addIssue({ code: 'custom', path: ['acceptanceCoverage', index, 'workUnitIds'], message: '每个本期或外部等待验收项必须且只能关联一个交付单元；跨单元验收请新增集成交付单元' });
    }
    if (coverage.disposition === 'waiting_external' && coverage.decisionId === undefined) {
      context.addIssue({ code: 'custom', path: ['acceptanceCoverage', index], message: '等待外部条件验收项必须关联决策和一个交付单元' });
    }
  }
});

export type WorkBreakdown = z.infer<typeof WorkBreakdownSchema>;

export class ImplementationWorkPlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImplementationWorkPlannerError';
  }
}

export async function readWorkBreakdown(task: Task, taskStore: TaskStore): Promise<WorkBreakdown> {
  const plan = task.nodes.plan;
  const path = plan === undefined || plan.revision === 0
    ? undefined
    : completedArtifactPath('plan', plan, 'artifacts/work-breakdown.yaml');
  if (path === undefined) {
    throw new ImplementationWorkPlannerError('实施工作单元声明缺失：计划尚未生成当前 revision');
  }
  try {
    const content = await readFile(join(taskStore.taskDirectory(task.id), path), 'utf8');
    return WorkBreakdownSchema.parse(parse(content));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ImplementationWorkPlannerError(formatWorkBreakdownIssues(error));
    }
    throw new ImplementationWorkPlannerError(`实施工作单元声明缺失或无法读取：${path}`);
  }
}

export async function materializeImplementationWork(task: Task, taskStore: TaskStore): Promise<{ task: Task; facts: Array<{ path: string; content: string }> }> {
  const plan = task.nodes.plan;
  const implementation = task.nodes.implement;
  if (plan === undefined || implementation?.skill === undefined || plan.status !== 'completed') {
    throw new ImplementationWorkPlannerError('计划尚未完成，无法生成实施工作单元');
  }
  const breakdown = await readWorkBreakdown(task, taskStore);
  await validateAcceptanceCoverage(task, taskStore, breakdown);
  const planRevision = plan.revision;
  const next = TaskSchema.parse(task);
  const generatedNodeIds = Object.entries(next.nodes)
    .filter(([nodeId, node]) => nodeId !== 'implement' && node.generatedFromPlanRevision !== undefined)
    .map(([nodeId]) => nodeId);
  for (const nodeId of generatedNodeIds) {
    next.nodes[nodeId]!.status = 'superseded';
    next.events.push({ type: 'supersede', nodeId, at: new Date().toISOString(), reason: `已由计划 r${planRevision} 重新生成` });
  }
  next.nodes.implement = { ...implementation, status: 'superseded', dependsOn: ['plan'], blockedByDecisionIds: undefined, acceptanceRefs: [] };
  next.events.push({ type: 'supersede', nodeId: 'implement', at: new Date().toISOString(), reason: `计划 r${planRevision} 已生成 ${breakdown.units.length} 个交付单元` });

  const nodeIds = new Map(breakdown.units.map((unit) => [unit.id, nextNodeId(next, `delivery-${unit.id}`, planRevision)]));
  const facts: Array<{ path: string; content: string }> = [];
  const taskDirectory = taskStore.taskDirectory(task.id);
  const planPath = completedArtifactPath('plan', plan, 'artifacts/implementation-plan.md');
  const breakdownPath = completedArtifactPath('plan', plan, 'artifacts/work-breakdown.yaml');
  const planHash = createHash('sha256').update(await readFile(join(taskDirectory, planPath))).digest('hex');
  const breakdownHash = createHash('sha256').update(await readFile(join(taskDirectory, breakdownPath))).digest('hex');
  const clarify = next.nodes.clarify;
  if (clarify === undefined || clarify.revision === 0) {
    throw new ImplementationWorkPlannerError('需求澄清事实尚未生成，无法构建交付单元上下文');
  }
  const [factContent, decisionContent] = await Promise.all([
    readFile(join(taskDirectory, completedArtifactPath('clarify', clarify, 'artifacts/fact-register.yaml')), 'utf8'),
    readFile(join(taskDirectory, completedArtifactPath('clarify', clarify, 'artifacts/decision-register.yaml')), 'utf8'),
  ]);
  const factsById = new Map(FactRegisterSchema.parse(parse(factContent)).items.map((fact) => [fact.id, fact]));
  const decisionsById = new Map(DecisionRegisterSchema.parse(parse(decisionContent)).items.map((decision) => [decision.id, decision]));

  const testProfiles = new ProjectTestProfiles();
  for (const unit of breakdown.units) {
    const nodeId = nodeIds.get(unit.id)!;
    const contextPath = `artifacts/work-units/r${planRevision}/${nodeId}.md`;
    const dependencies = ['plan', ...unit.dependsOn.map((dependency) => nodeIds.get(dependency)!)];
    const blockedByDecisionIds = unit.blockedBy.filter((decisionId) => {
      const resolution = next.decisions.find((decision) => decision.id === decisionId);
      return resolution === undefined || resolution.status === 'waiting_external';
    });
    // task.repository is task metadata and may be relative (for example `.`).
    // The TaskStore owns the resolved business-repository directory, so test
    // profile discovery must use it rather than the CLI process directory.
    const verificationCommands = await testProfiles.resolve(taskStore.projectDirectory(), unit.verification);
    const node: TaskNode = {
      title: unit.title,
      phase: 'implement',
      dependsOn: [...new Set(dependencies)],
      skill: implementation.skill,
      requiresApproval: true,
      status: blockedByDecisionIds.length > 0 ? 'blocked' : dependencies.every((dependency) => next.nodes[dependency]?.status === 'completed') ? 'ready' : 'pending',
      revision: 0,
      outputs: ['artifacts/delivery.md', 'artifacts/acceptance-intent.yaml', 'artifacts/test-results.yaml', 'artifacts/acceptance-results.yaml'],
      contextPath,
      generatedFromPlanRevision: planRevision,
      workUnitId: unit.id,
      verificationCommands,
      acceptanceRefs: unit.acceptanceRefs,
      decisionRefs: unit.decisionRefs,
      ...(blockedByDecisionIds.length === 0 ? {} : { blockedByDecisionIds }),
    };
    next.nodes[nodeId] = node;
    facts.push({ path: contextPath, content: renderUnitContext(unit, verificationCommands, task.id, planRevision, planPath, breakdownPath, planHash, breakdownHash, factsById, decisionsById, next) });
    next.events.push({ type: 'materialize_implementation', nodeId, at: new Date().toISOString(), note: `计划 r${planRevision}；工作单元：${unit.id}` });
  }
  return { task: TaskSchema.parse(deriveTaskStatus(next)), facts };
}

export function validateWorkBreakdown(content: string): void {
  try {
    WorkBreakdownSchema.parse(parse(content));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ImplementationWorkPlannerError(formatWorkBreakdownIssues(error));
    }
    throw new ImplementationWorkPlannerError('实施工作单元声明不是有效 YAML');
  }
}

function formatWorkBreakdownIssues(error: z.ZodError): string {
  const items = new Map<string, string[]>();
  const general: string[] = [];
  for (const issue of error.issues) {
    const location = workBreakdownIssueLocation(issue.path);
    const messages = location === undefined
      ? [issue.message]
      : workBreakdownIssueMessages(issue, location.kind);
    if (location === undefined) {
      general.push(...messages);
    } else {
      items.set(location.label, [...(items.get(location.label) ?? []), ...messages]);
    }
  }
  const lines = [
    '实施工作单元声明无效：',
    ...[...items.entries()].flatMap(([label, messages]) => [
      `- ${label}：`,
      ...[...new Set(messages)].map((message) => `  - ${message}`),
    ]),
    ...[...new Set(general)].map((message) => `- ${message}`),
  ];
  return lines.join('\n');
}

function workBreakdownIssueLocation(path: PropertyKey[]): { label: string; kind: 'coverage' | 'unit' } | undefined {
  if (path[0] === 'acceptanceCoverage' && typeof path[1] === 'number') {
    return { label: `验收覆盖第 ${path[1] + 1} 项`, kind: 'coverage' };
  }
  if (path[0] === 'units' && typeof path[1] === 'number') {
    return { label: `工作单元第 ${path[1] + 1} 项`, kind: 'unit' };
  }
  return undefined;
}

function workBreakdownIssueMessages(issue: z.core.$ZodIssue, kind: 'coverage' | 'unit'): string[] {
  const field = issue.path.at(-1);
  if (kind === 'coverage' && field === 'acceptanceId' && issue.code === 'invalid_type') {
    return ['缺少 acceptanceId；应填写验收项编号，例如 AC-01。'];
  }
  if (kind === 'coverage' && field === 'disposition' && issue.code === 'invalid_value') {
    return ['缺少或错误使用 disposition；只能是 implement、waiting_external。'];
  }
  if (issue.code === 'unrecognized_keys') {
    const keys = (issue as { keys: string[] }).keys;
    const aliases = kind === 'coverage'
      ? {
          acceptanceRef: '不能使用 acceptanceRef；请改为 acceptanceId。',
          status: '不能使用 status；请改为 disposition。',
          units: '不能使用 units；请改为 workUnitIds。',
          decisions: '不能使用 decisions；等待外部条件只使用单个 decisionId。',
          blockedUnits: '不能使用 blockedUnits；请改为 workUnitIds，并在对应工作单元声明 blockedBy。',
          reason: '不能使用 reason；外部等待原因应写入关联决策事实。',
        }
      : {
          acceptanceIds: '不能使用 acceptanceIds；请改为 acceptanceRefs。',
          paths: '不能使用 paths；请使用 steps 描述实施边界。',
          commands: '不能使用 commands；请改为 verification。',
          command: '不能使用 command；每项 verification 必须使用 profile 和可选 targets。',
          dependencies: '不能使用 dependencies；请改为 dependsOn。',
          requiresApproval: '交付单元固定需要审批；不要声明 requiresApproval。',
        };
    return keys.map((key) => aliases[key as keyof typeof aliases] ?? `不支持字段 ${key}。`);
  }
  return [issue.message];
}

export async function validatePlanAcceptanceCoverage(task: Task, taskStore: TaskStore): Promise<void> {
  const breakdown = await readWorkBreakdown(task, taskStore);
  await validateAcceptanceCoverage(task, taskStore, breakdown);
  await validateWorkflowPathPlan(task, taskStore, breakdown);
}

/**
 * The quick path is intentionally narrow.  A plan cannot silently turn an
 * eligible small change into a multi-unit or decision-dependent delivery;
 * that must be re-reviewed as a standard requirement instead.
 */
export async function validateWorkflowPathPlan(task: Task, taskStore: TaskStore, breakdown: WorkBreakdown): Promise<void> {
  if (task.workflowPath?.id !== 'quick') return;
  const catalog = await readAcceptanceCatalog(task, taskStore);
  const errors: string[] = [];
  if (catalog.items.length !== 1) errors.push('快速修改必须只有一个验收项');
  if (breakdown.units.length !== 1) errors.push('快速修改必须且只能生成一个交付单元');
  if (breakdown.acceptanceCoverage.length !== 1) errors.push('快速修改必须且只能声明一个验收覆盖项');
  const unit = breakdown.units[0];
  const coverage = breakdown.acceptanceCoverage[0];
  const acceptanceId = catalog.items[0]?.id;
  if (unit !== undefined) {
    if (unit.dependsOn.length > 0) errors.push('快速修改的交付单元不得依赖其他交付单元');
    if (unit.decisionRefs.length > 0 || unit.blockedBy.length > 0) errors.push('快速修改不得引用决策或等待外部条件');
    if (acceptanceId !== undefined && (unit.acceptanceRefs.length !== 1 || unit.acceptanceRefs[0] !== acceptanceId)) {
      errors.push(`快速修改的唯一交付单元必须只覆盖 ${acceptanceId}`);
    }
  }
  if (coverage !== undefined && (coverage.disposition !== 'implement' || coverage.decisionId !== undefined || coverage.workUnitIds.length !== 1 || coverage.workUnitIds[0] !== unit?.id || coverage.acceptanceId !== acceptanceId)) {
    errors.push('快速修改的验收覆盖必须由唯一交付单元以 implement 方式完成');
  }
  if (errors.length > 0) {
    throw new ImplementationWorkPlannerError(`快速修改计划不满足约束：${errors.join('；')}。请重新执行 aiw task review 并选择标准需求。`);
  }
}

async function validateAcceptanceCoverage(task: Task, taskStore: TaskStore, breakdown: WorkBreakdown): Promise<void> {
  const catalog = await readAcceptanceCatalog(task, taskStore);
  const catalogIds = new Set(catalog.items.map((item) => item.id));
  const coverageByAcceptance = new Map(breakdown.acceptanceCoverage.map((coverage) => [coverage.acceptanceId, coverage]));
  const missing = catalog.items.filter((item) => !coverageByAcceptance.has(item.id)).map((item) => item.id);
  const unknown = breakdown.acceptanceCoverage.filter((coverage) => !catalogIds.has(coverage.acceptanceId)).map((coverage) => coverage.acceptanceId);
  const errors: string[] = [];
  if (missing.length > 0) errors.push(`未声明覆盖方式：${missing.join('、')}`);
  if (unknown.length > 0) errors.push(`引用了不存在的验收项：${unknown.join('、')}`);

  for (const coverage of breakdown.acceptanceCoverage) {
    const units = coverage.workUnitIds.map((id) => breakdown.units.find((unit) => unit.id === id)!);
    if (coverage.disposition === 'implement' && (units.length !== 1 || !units[0]!.acceptanceRefs.includes(coverage.acceptanceId))) {
      errors.push(`${coverage.acceptanceId} 的实施单元必须在 acceptanceRefs 中声明该验收项`);
    }
    if (coverage.disposition === 'waiting_external') {
      const decision = task.decisions.find((item) => item.id === coverage.decisionId);
      if (decision?.status !== 'waiting_external') {
        errors.push(`${coverage.acceptanceId} 声明等待外部条件，但 ${coverage.decisionId} 不是当前外部等待决策`);
      }
      if (units.length !== 1 || units.some((unit) => !unit.acceptanceRefs.includes(coverage.acceptanceId) || !unit.blockedBy.includes(coverage.decisionId!))) {
        errors.push(`${coverage.acceptanceId} 的等待工作单元必须引用 ${coverage.decisionId}`);
      }
    }
  }
  for (const unit of breakdown.units) {
    for (const acceptanceId of unit.acceptanceRefs) {
      const coverage = coverageByAcceptance.get(acceptanceId);
      if (coverage === undefined ||
        (!['implement', 'waiting_external'].includes(coverage.disposition) || !coverage.workUnitIds.includes(unit.id))) {
        errors.push(`工作单元 ${unit.id} 引用的 ${acceptanceId} 未与该单元形成一致覆盖声明`);
      }
    }
  }
  if (errors.length > 0) throw new ImplementationWorkPlannerError(`验收覆盖不完整或不一致：${errors.join('；')}`);
}

async function readAcceptanceCatalog(task: Task, taskStore: TaskStore): Promise<AcceptanceCatalog> {
  const clarify = task.nodes.clarify;
  const path = clarify === undefined || clarify.revision === 0
    ? undefined
    : completedArtifactPath('clarify', clarify, 'artifacts/acceptance.yaml');
  if (path === undefined) {
    throw new ImplementationWorkPlannerError('验收清单缺失：需求澄清尚未生成当前 revision');
  }
  try {
    const content = await readFile(join(taskStore.taskDirectory(task.id), path), 'utf8');
    return AcceptanceCatalogSchema.parse(parse(content));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ImplementationWorkPlannerError(formatSchemaDiagnostics({
        title: '验收清单',
        error,
        aliases: {
          acceptanceId: '不能使用 acceptanceId；请改为 id。',
          name: '不能使用 name；请改为 title。',
          criteria: '不能使用 criteria；请改为 description。',
        },
        itemLabel: '验收项',
      }));
    }
    throw new ImplementationWorkPlannerError(`验收清单缺失或无法读取：${path}`);
  }
}

function nextNodeId(task: Task, base: string, planRevision: number): string {
  return task.nodes[base] === undefined ? base : `${base}-r${planRevision}`;
}

function renderUnitContext(
  unit: WorkBreakdown['units'][number],
  verificationCommands: string[],
  taskId: string,
  planRevision: number,
  planPath: string,
  breakdownPath: string,
  planHash: string,
  breakdownHash: string,
  factsById: Map<string, { kind: string; statement: string }>,
  decisionsById: Map<string, { title: string }>,
  task: Task,
): string {
  return [
    `# 交付单元上下文：${unit.title}`,
    '',
    '## 来源',
    `- 任务：${taskId}`,
    `- 实施计划：${planPath}（r${planRevision}，sha256:${planHash}）`,
    `- 工作单元声明：${breakdownPath}（sha256:${breakdownHash}）`,
    '',
    '## 目标',
    unit.goal,
    '',
    '## 验收项',
    ...unit.acceptanceRefs.map((reference) => `- ${reference}`),
    '',
    '## 关联事实',
    ...unit.factRefs.map((reference) => {
      const fact = factsById.get(reference);
      if (fact === undefined) throw new ImplementationWorkPlannerError(`工作单元 ${unit.id} 引用了不存在的事实 ${reference}`);
      return `- ${reference}（${fact.kind}）：${fact.statement}`;
    }),
    '',
    '## 关联决策',
    ...(unit.decisionRefs.length === 0
      ? ['- 无。']
      : unit.decisionRefs.map((reference) => {
        const decision = decisionsById.get(reference);
        if (decision === undefined) throw new ImplementationWorkPlannerError(`工作单元 ${unit.id} 引用了不存在的决策 ${reference}`);
        const resolution = task.decisions.find((item) => item.id === reference);
        return `- ${reference}：${decision.title}（当前处理：${resolution?.status ?? '尚未处理'}）`;
      })),
    '',
    '## 交付步骤',
    ...unit.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## 工程验证与验收测试',
    ...verificationCommands.map((command) => `- ${command}`),
    '',
    '## 交付要求',
    '- 在本单元内完成代码修改、工程验证和验收测试；不得等待全局验证节点。',
    '- 只为上述验收项生成验收结果；跨单元验收必须由计划声明的集成交付单元负责。',
    '',
  ].join('\n');
}

function hasCycle(units: Array<{ id: string; dependsOn: string[] }>): boolean {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cycle = byId.get(id)?.dependsOn.some(visit) ?? false;
    visiting.delete(id);
    visited.add(id);
    return cycle;
  };
  return units.some((unit) => visit(unit.id));
}
