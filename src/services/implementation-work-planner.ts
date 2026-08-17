import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

import { AcceptanceCatalogSchema, type AcceptanceCatalog } from '../domain/acceptance-catalog.js';
import { TaskSchema, type Task, type TaskNode } from '../domain/task.js';
import { TaskStore } from './task-store.js';
import { deriveTaskStatus } from './task-state-machine.js';

const unitIdPattern = /^[a-z][a-z0-9-]{0,40}$/;
const allowedPathPattern = /^(?![./])(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

const WorkUnitSchema = z.object({
  id: z.string().regex(unitIdPattern, '工作单元 ID 格式无效'),
  title: z.string().min(1),
  goal: z.string().min(1),
  allowedPaths: z.array(z.string().regex(allowedPathPattern, '允许变更路径无效')).min(1),
  acceptanceRefs: z.array(z.string().min(1)).min(1),
  steps: z.array(z.string().min(1)).min(1),
  verification: z.array(z.string().min(1)).min(1),
  blockedBy: z.array(z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效')).default([]),
  dependsOn: z.array(z.string().regex(unitIdPattern, '依赖工作单元 ID 格式无效')).default([]),
  requiresApproval: z.boolean().default(false),
});

const AcceptanceCoverageSchema = z.object({
  acceptanceId: z.string().regex(/^AC-\d{2,}$/, '验收项 ID 格式无效'),
  disposition: z.enum(['implement', 'waiting_external', 'deferred', 'waived']),
  workUnitIds: z.array(z.string().regex(unitIdPattern, '工作单元 ID 格式无效')).default([]),
  decisionId: z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效').optional(),
}).strict();

export const WorkBreakdownSchema = z.object({
  schemaVersion: z.literal('aiw.work-breakdown/v1'),
  units: z.array(WorkUnitSchema).min(1),
  acceptanceCoverage: z.array(AcceptanceCoverageSchema).min(1),
}).superRefine((breakdown, context) => {
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
    if (coverage.disposition === 'implement' && coverage.workUnitIds.length === 0) {
      context.addIssue({ code: 'custom', path: ['acceptanceCoverage', index, 'workUnitIds'], message: '本期实施验收项必须关联至少一个工作单元' });
    }
    if (coverage.disposition === 'waiting_external' && (coverage.decisionId === undefined || coverage.workUnitIds.length === 0)) {
      context.addIssue({ code: 'custom', path: ['acceptanceCoverage', index], message: '等待外部条件验收项必须关联决策和至少一个工作单元' });
    }
    if (['deferred', 'waived'].includes(coverage.disposition) && coverage.decisionId === undefined) {
      context.addIssue({ code: 'custom', path: ['acceptanceCoverage', index, 'decisionId'], message: '拆期或风险豁免验收项必须关联决策' });
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
  try {
    const content = await readFile(join(taskStore.taskDirectory(task.id), 'artifacts', 'work-breakdown.yaml'), 'utf8');
    return WorkBreakdownSchema.parse(parse(content));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ImplementationWorkPlannerError(`实施工作单元声明无效：${error.issues.map((issue) => issue.message).join('；')}`);
    }
    throw new ImplementationWorkPlannerError('实施工作单元声明缺失或无法读取：artifacts/work-breakdown.yaml');
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
  const verify = next.nodes.verify;
  if (verify === undefined || !['pending', 'invalidated'].includes(verify.status)) {
    throw new ImplementationWorkPlannerError('工程验证已开始，不能重新生成实施工作单元');
  }
  verify.status = 'pending';

  const generatedNodeIds = Object.entries(next.nodes)
    .filter(([nodeId, node]) => nodeId !== 'implement' && node.generatedFromPlanRevision !== undefined)
    .map(([nodeId]) => nodeId);
  for (const nodeId of generatedNodeIds) {
    next.nodes[nodeId]!.status = 'superseded';
    next.events.push({ type: 'supersede', nodeId, at: new Date().toISOString(), reason: `已由计划 r${planRevision} 重新生成` });
  }
  const split = breakdown.units.length > 1;
  verify.dependsOn = verify.dependsOn.filter((nodeId) => nodeId !== 'implement' && !generatedNodeIds.includes(nodeId));
  if (split) {
    next.nodes.implement = { ...implementation, status: 'superseded' };
    next.events.push({ type: 'supersede', nodeId: 'implement', at: new Date().toISOString(), reason: `计划 r${planRevision} 已拆分为 ${breakdown.units.length} 个实施单元` });
  } else {
    verify.dependsOn = [...new Set([...verify.dependsOn, 'implement'])];
  }

  const nodeIds = new Map(breakdown.units.map((unit, index) => [unit.id, !split && index === 0 ? 'implement' : nextNodeId(next, `implement-${unit.id}`, planRevision)]));
  const facts: Array<{ path: string; content: string }> = [];
  const taskDirectory = taskStore.taskDirectory(task.id);
  const planHash = createHash('sha256').update(await readFile(join(taskDirectory, 'artifacts', 'implementation-plan.md'))).digest('hex');
  const breakdownHash = createHash('sha256').update(await readFile(join(taskDirectory, 'artifacts', 'work-breakdown.yaml'))).digest('hex');

  for (const unit of breakdown.units) {
    const nodeId = nodeIds.get(unit.id)!;
    const contextPath = breakdown.units.length === 1
      ? 'artifacts/implementation-context.md'
      : `artifacts/work-units/r${planRevision}/${nodeId}.md`;
    const dependencies = ['plan', ...unit.dependsOn.map((dependency) => nodeIds.get(dependency)!)];
    const deferred = unit.blockedBy.some((decisionId) => next.decisions.find((decision) => decision.id === decisionId)?.status === 'deferred');
    const blockedByDecisionIds = unit.blockedBy.filter((decisionId) => {
      const resolution = next.decisions.find((decision) => decision.id === decisionId);
      return resolution === undefined || resolution.status === 'waiting_external';
    });
    const node: TaskNode = {
      title: unit.title,
      phase: 'implement',
      dependsOn: [...new Set(dependencies)],
      skill: implementation.skill,
      requiresApproval: unit.requiresApproval,
      status: deferred ? 'superseded' : blockedByDecisionIds.length > 0 ? 'blocked' : dependencies.every((dependency) => next.nodes[dependency]?.status === 'completed') ? 'ready' : 'pending',
      revision: nodeId === 'implement' ? implementation.revision : 0,
      outputs: nodeId === 'implement' ? ['artifacts/implementation.md'] : [`artifacts/subtasks/${nodeId}.md`],
      allowedPaths: [...new Set(unit.allowedPaths)],
      contextPath,
      generatedFromPlanRevision: planRevision,
      ...(blockedByDecisionIds.length === 0 || deferred ? {} : { blockedByDecisionIds }),
    };
    next.nodes[nodeId] = node;
    if (nodeId !== 'implement' && node.status !== 'superseded') {
      verify.dependsOn = [...new Set([...verify.dependsOn, nodeId])];
    }
    if (breakdown.units.length > 1) {
      facts.push({ path: contextPath, content: renderUnitContext(unit, task.id, planRevision, planHash, breakdownHash) });
    }
    next.events.push({ type: 'materialize_implementation', nodeId, at: new Date().toISOString(), note: `计划 r${planRevision}；工作单元：${unit.id}` });
  }
  return { task: TaskSchema.parse(deriveTaskStatus(next)), facts };
}

export function validateWorkBreakdown(content: string): void {
  try {
    WorkBreakdownSchema.parse(parse(content));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ImplementationWorkPlannerError(`实施工作单元声明无效：${error.issues.map((issue) => issue.message).join('；')}`);
    }
    throw new ImplementationWorkPlannerError('实施工作单元声明不是有效 YAML');
  }
}

export async function validatePlanAcceptanceCoverage(task: Task, taskStore: TaskStore): Promise<void> {
  await validateAcceptanceCoverage(task, taskStore, await readWorkBreakdown(task, taskStore));
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
    if (coverage.disposition === 'implement' && units.some((unit) => !unit.acceptanceRefs.includes(coverage.acceptanceId))) {
      errors.push(`${coverage.acceptanceId} 的实施单元必须在 acceptanceRefs 中声明该验收项`);
    }
    if (coverage.disposition === 'waiting_external') {
      const decision = task.decisions.find((item) => item.id === coverage.decisionId);
      if (decision?.status !== 'waiting_external') {
        errors.push(`${coverage.acceptanceId} 声明等待外部条件，但 ${coverage.decisionId} 不是当前外部等待决策`);
      }
      if (units.some((unit) => !unit.acceptanceRefs.includes(coverage.acceptanceId) || !unit.blockedBy.includes(coverage.decisionId!))) {
        errors.push(`${coverage.acceptanceId} 的等待工作单元必须引用 ${coverage.decisionId}`);
      }
    }
    if (coverage.disposition === 'deferred' || coverage.disposition === 'waived') {
      const decision = task.decisions.find((item) => item.id === coverage.decisionId);
      if (decision?.status !== coverage.disposition || decision.note === undefined) {
        errors.push(`${coverage.acceptanceId} 声明${coverage.disposition === 'deferred' ? '拆期' : '风险豁免'}，但 ${coverage.decisionId} 缺少对应的当前决策事实或说明`);
      }
    }
  }
  for (const unit of breakdown.units) {
    for (const acceptanceId of unit.acceptanceRefs) {
      const coverage = coverageByAcceptance.get(acceptanceId);
      if (coverage === undefined ||
        (coverage.disposition !== 'deferred' && (!['implement', 'waiting_external'].includes(coverage.disposition) || !coverage.workUnitIds.includes(unit.id))) ||
        (coverage.disposition === 'deferred' && !unit.blockedBy.includes(coverage.decisionId!))) {
        errors.push(`工作单元 ${unit.id} 引用的 ${acceptanceId} 未与该单元形成一致覆盖声明`);
      }
    }
  }
  if (errors.length > 0) throw new ImplementationWorkPlannerError(`验收覆盖不完整或不一致：${errors.join('；')}`);
}

async function readAcceptanceCatalog(task: Task, taskStore: TaskStore): Promise<AcceptanceCatalog> {
  try {
    const content = await readFile(join(taskStore.taskDirectory(task.id), 'artifacts', 'acceptance.yaml'), 'utf8');
    return AcceptanceCatalogSchema.parse(parse(content));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ImplementationWorkPlannerError(`验收清单无效：${error.issues.map((issue) => issue.message).join('；')}`);
    }
    throw new ImplementationWorkPlannerError('验收清单缺失或无法读取：artifacts/acceptance.yaml');
  }
}

function nextNodeId(task: Task, base: string, planRevision: number): string {
  return task.nodes[base] === undefined ? base : `${base}-r${planRevision}`;
}

function renderUnitContext(unit: WorkBreakdown['units'][number], taskId: string, planRevision: number, planHash: string, breakdownHash: string): string {
  return [
    `# 实施上下文：${unit.title}`,
    '',
    '## 来源',
    `- 任务：${taskId}`,
    `- 实施计划：artifacts/implementation-plan.md（r${planRevision}，sha256:${planHash}）`,
    `- 工作单元声明：artifacts/work-breakdown.yaml（sha256:${breakdownHash}）`,
    '',
    '## 目标',
    unit.goal,
    '',
    '## 允许修改',
    ...unit.allowedPaths.map((path) => `- ${path}`),
    '',
    '## 验收项',
    ...unit.acceptanceRefs.map((reference) => `- ${reference}`),
    '',
    '## 实施步骤',
    ...unit.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## 验证',
    ...unit.verification.map((command) => `- ${command}`),
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
