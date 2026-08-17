import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Command } from 'commander';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { TaskSchema, type SkillLock, type Task, type TaskNode } from '../domain/task.js';
import { outputPathsForCompletedRun } from '../domain/handoff.js';
import type { SkillRegistry } from '../services/skill-registry.js';
import { TaskFactGuard } from '../services/task-fact-guard.js';
import { deriveTaskStatus, transitionNode } from '../services/task-state-machine.js';
import { TaskStore } from '../services/task-store.js';
import { loadRunCompletionBundle } from '../services/run-completion-bundle.js';
import { TaskCancellationService } from '../services/task-cancellation-service.js';
import { materializeImplementationWork } from '../services/implementation-work-planner.js';
import { HandoffMigrator, type HandoffMigrationResult } from '../services/handoff-migrator.js';
import { TaskDecisionService } from '../services/task-decision-service.js';
import { AcceptanceResultsSchema, deliveryStatusFromAcceptanceResults } from '../domain/acceptance-results.js';
import { type HumanOutput, writeCommandResult } from './output.js';
import { TerminalProgressReporter, withProgress, type ProgressReporter } from './progress-reporter.js';
import { createReviewPrompter, type ReviewPrompter } from './review-prompter.js';

const ApprovalFactSchema = z.object({
  nodeId: z.string().min(1),
  nodeRevision: z.number().int().positive(),
  artifactHashes: z.record(z.string(), z.string().regex(/^sha256:[a-f0-9]{64}$/)),
  decision: z.literal('approved'),
  actor: z.string().min(1),
  at: z.string().datetime(),
  note: z.string().optional(),
});

type ClarifyDecisionSelection = {
  decisionId: string;
  optionId: string;
  status?: 'resolved' | 'waiting_external';
  owner?: string;
  unblockCondition?: string;
  manualNote?: string;
};

export class TaskStateCommands {
  constructor(private readonly deps: { taskStore: TaskStore; taskFactGuard: TaskFactGuard; skillRegistry?: SkillRegistry; cancellation?: TaskCancellationService; handoffMigrator?: HandoffMigrator; decisionService?: TaskDecisionService }) {}

  async status(taskId: string): Promise<Task> {
    return this.deps.taskStore.load(taskId);
  }

  async uncommittedTaskPaths(taskId: string): Promise<string[]> {
    const task = await this.deps.taskStore.load(taskId);
    const taskDirectory = relative(this.deps.taskStore.projectDirectory(), this.deps.taskStore.taskDirectory(task.id)).replaceAll('\\', '/');
    return this.deps.taskFactGuard.uncommittedPaths({
      task,
      projectRoot: this.deps.taskStore.projectDirectory(),
      paths: [taskDirectory],
    });
  }

  async migrateHandoffs(taskId: string): Promise<{ task: Task; migration: HandoffMigrationResult }> {
    if (this.deps.handoffMigrator === undefined) throw new Error('当前环境不支持历史交接包迁移');
    const migration = await this.deps.handoffMigrator.migrate({ taskId });
    return { task: await this.deps.taskStore.load(taskId), migration };
  }

  async listDecisions(taskId: string) {
    if (this.deps.decisionService === undefined) throw new Error('当前环境不支持决策管理');
    return this.deps.decisionService.list(taskId);
  }

  async chooseDecision(taskId: string, decisionId: string, options: { option: string; actor?: string; note?: string }): Promise<Task> {
    if (this.deps.decisionService === undefined) throw new Error('当前环境不支持决策管理');
    await this.assertDecisionRegisterCommitted(taskId);
    return this.deps.decisionService.choose({ taskId, decisionId, optionId: options.option, actor: await this.deps.taskFactGuard.actor(options.actor), status: 'resolved', ...(options.note === undefined ? {} : { note: options.note }) });
  }

  async waitDecision(taskId: string, decisionId: string, options: { option: string; owner: string; unblockCondition: string; actor?: string; note?: string }): Promise<Task> {
    if (this.deps.decisionService === undefined) throw new Error('当前环境不支持决策管理');
    await this.assertDecisionRegisterCommitted(taskId);
    return this.deps.decisionService.choose({ taskId, decisionId, optionId: options.option, actor: await this.deps.taskFactGuard.actor(options.actor), status: 'waiting_external', owner: options.owner, unblockCondition: options.unblockCondition, ...(options.note === undefined ? {} : { note: options.note }) });
  }

  async deferDecision(taskId: string, decisionId: string, options: { option: string; note: string; actor?: string }): Promise<Task> {
    if (this.deps.decisionService === undefined) throw new Error('当前环境不支持决策管理');
    await this.assertDecisionRegisterCommitted(taskId);
    return this.deps.decisionService.choose({ taskId, decisionId, optionId: options.option, actor: await this.deps.taskFactGuard.actor(options.actor), status: 'deferred', note: options.note });
  }

  async waiveDecision(taskId: string, decisionId: string, options: { option: string; note: string; actor?: string }): Promise<Task> {
    if (this.deps.decisionService === undefined) throw new Error('当前环境不支持决策管理');
    await this.assertDecisionRegisterCommitted(taskId);
    return this.deps.decisionService.choose({ taskId, decisionId, optionId: options.option, actor: await this.deps.taskFactGuard.actor(options.actor), status: 'waived', note: options.note });
  }

  async resolveDecision(taskId: string, decisionId: string, options: { note: string; actor?: string }): Promise<Task> {
    if (this.deps.decisionService === undefined) throw new Error('当前环境不支持决策管理');
    await this.assertDecisionRegisterCommitted(taskId);
    return this.deps.decisionService.resolve({ taskId, decisionId, actor: await this.deps.taskFactGuard.actor(options.actor), note: options.note });
  }

  async approve(taskId: string, nodeId: string, options: { actor?: string; note?: string }): Promise<Task> {
    return this.decide(taskId, nodeId, 'approved', options);
  }

  async reviewClarify(taskId: string, selections: ClarifyDecisionSelection[], options: { actor?: string; note?: string }): Promise<Task> {
    if (this.deps.decisionService === undefined) throw new Error('当前环境不支持决策管理');
    const task = await this.deps.taskStore.load(taskId);
    const clarify = task.nodes.clarify;
    if (clarify?.status !== 'awaiting_approval') {
      throw new Error('只有待审批的需求澄清节点可以进行确认');
    }
    const decisions = await this.deps.decisionService.list(taskId);
    const outstanding = decisions.filter(({ resolution }) => resolution === undefined);
    const selectedIds = new Set(selections.map((selection) => selection.decisionId));
    if (selectedIds.size !== selections.length || outstanding.length !== selections.length || outstanding.some(({ item }) => !selectedIds.has(item.id))) {
      throw new Error('需求澄清确认必须逐项处理所有待决策事项');
    }
    const completionBundle = await loadRunCompletionBundle(task, this.deps.taskStore, 'clarify');
    await this.deps.taskFactGuard.assertCommitted({
      task,
      projectRoot: this.deps.taskStore.projectDirectory(),
      paths: ['task.yaml', 'artifacts/decision-register.yaml', ...completionBundle.paths],
    });
    const actor = await this.deps.taskFactGuard.actor(options.actor);
    for (const selection of selections) {
      await this.deps.decisionService.choose({
        taskId,
        decisionId: selection.decisionId,
        optionId: selection.optionId,
        actor,
        status: selection.status ?? 'resolved',
        ...(selection.owner === undefined ? {} : { owner: selection.owner }),
        ...(selection.unblockCondition === undefined ? {} : { unblockCondition: selection.unblockCondition }),
        ...(selection.manualNote === undefined ? options.note === undefined ? {} : { note: options.note } : { note: selection.manualNote }),
      });
    }
    return this.decide(taskId, 'clarify', 'approved', { actor, note: options.note }, { skipCommittedCheck: true });
  }

  async closeWithRisk(taskId: string, options: { actor?: string; owner: string; reason: string; expiresAt: string }): Promise<Task> {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(options.expiresAt) || Number.isNaN(Date.parse(options.expiresAt))) {
      throw new Error('风险到期时间必须为 ISO 8601 时间');
    }
    return this.decide(taskId, 'test', 'approved', { actor: options.actor, note: options.reason, riskAcceptance: { owner: options.owner, reason: options.reason, expiresAt: options.expiresAt } });
  }

  async fail(taskId: string, nodeId: string, options: { actor?: string; note: string }): Promise<Task> {
    const task = await this.deps.taskStore.load(taskId);
    const actor = await this.deps.taskFactGuard.actor(options.actor);
    const next = transitionNode(task, nodeId, { type: 'fail', message: options.note.trim(), actor });
    await this.deps.taskStore.update(next);
    return next;
  }

  async cancel(taskId: string, nodeId: string, options: { note: string }): Promise<{ taskId: string; nodeId: string; runId: string; status: 'requested' | 'signalled' }> {
    if (this.deps.cancellation === undefined) throw new Error('当前环境不支持取消运行');
    return this.deps.cancellation.request({ taskId, nodeId, note: options.note.trim() });
  }

  async rebindSkill(taskId: string, nodeId: string, options: { skill: string; note: string }): Promise<Task> {
    if (this.deps.skillRegistry === undefined) {
      throw new Error('技能注册表不可用');
    }
    const [name, version] = parseReference(options.skill);
    const skill = await this.deps.skillRegistry.find(name, version);
    if (skill === undefined) {
      throw new Error('技能不存在');
    }
    const task = await this.deps.taskStore.load(taskId);
    const node = task.nodes[nodeId];
    if (node === undefined) {
      throw new Error(`未知节点：${nodeId}`);
    }
    if (!skill.phases.includes(node.phase as typeof skill.phases[number])) {
      throw new Error('技能与节点阶段不兼容');
    }
    const next = transitionNode(task, nodeId, { type: 'rebind_skill', skill: lockSkill(skill), note: options.note });
    await this.deps.taskStore.update(next);
    return next;
  }

  async addSubtask(taskId: string, nodeId: string, options: { title: string; dependsOn: string[]; before: string[]; allowedPaths: string[]; requiresApproval: boolean }): Promise<Task> {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(nodeId)) throw new Error('子任务节点 ID 格式无效');
    const task = await this.deps.taskStore.load(taskId);
    if (task.nodes[nodeId] !== undefined) throw new Error(`子任务节点已存在：${nodeId}`);
    const dependencies = [...new Set(options.dependsOn.length === 0 ? ['plan'] : options.dependsOn)];
    const mergeTargets = [...new Set(options.before.length === 0 ? ['verify'] : options.before)];
    for (const dependency of dependencies) if (task.nodes[dependency] === undefined) throw new Error(`未知依赖节点：${dependency}`);
    for (const target of mergeTargets) {
      const node = task.nodes[target];
      if (node === undefined) throw new Error(`未知汇合节点：${target}`);
      if (node.status !== 'pending') throw new Error(`只能在未开始的节点前汇合：${target}`);
    }
    const template = task.nodes.implement;
    if (template?.skill === undefined) throw new Error('任务未锁定实施技能，无法创建子任务');
    const title = options.title.trim();
    if (title.length === 0) throw new Error('子任务标题不能为空');
    const allowedPaths = [...new Set(options.allowedPaths.map((path) => path.trim()).filter(Boolean))];
    if (allowedPaths.length === 0 || allowedPaths.some((path) => path.startsWith('.') || path.startsWith('/') || path.split('/').includes('..'))) {
      throw new Error('子任务必须声明至少一个有效的业务变更路径');
    }
    const subtask: TaskNode = {
      title, phase: 'implement', dependsOn: dependencies, skill: template.skill,
      requiresApproval: options.requiresApproval,
      status: dependencies.every((dependency) => task.nodes[dependency]?.status === 'completed') ? 'ready' : 'pending',
      revision: 0, outputs: [`artifacts/subtasks/${nodeId}.md`], allowedPaths, contextPath: 'artifacts/implementation-context.md',
    };
    task.nodes[nodeId] = subtask;
    for (const target of mergeTargets) task.nodes[target]!.dependsOn = [...new Set([...task.nodes[target]!.dependsOn, nodeId])];
    task.events.push({ type: 'add_subtask', nodeId, at: new Date().toISOString(), note: `依赖：${dependencies.join('、')}；汇合：${mergeTargets.join('、')}` });
    const next = TaskSchema.parse(deriveTaskStatus(task));
    await this.deps.taskStore.update(next);
    return next;
  }

  private async decide(
    taskId: string,
    nodeId: string,
    decision: 'approved',
    options: { actor?: string; note?: string; riskAcceptance?: { owner: string; reason: string; expiresAt: string } },
    internal: { skipCommittedCheck?: boolean } = {},
  ): Promise<Task> {
    const task = await this.deps.taskStore.load(taskId);
    const node = task.nodes[nodeId];
    if (node === undefined) {
      throw new Error(`未知节点：${nodeId}`);
    }
    if (node.status !== 'awaiting_approval') {
      throw new Error('只能审批等待审批的节点');
    }
    const note = options.note?.trim();
    if (decision === 'approved' && nodeId === 'clarify') {
      await this.assertClarifyDecisionsReviewed(taskId);
    }
    const completionBundle = await loadRunCompletionBundle(task, this.deps.taskStore, nodeId);
    if (!internal.skipCommittedCheck) {
      await this.deps.taskFactGuard.assertCommitted({ task, projectRoot: this.deps.taskStore.projectDirectory(), paths: ['task.yaml', ...completionBundle.paths] });
    }
    const actor = await this.deps.taskFactGuard.actor(options.actor);
    const deliveryStatus = nodeId === 'test' && decision === 'approved'
      ? await readDeliveryStatus(task, this.deps.taskStore)
      : undefined;
    if (nodeId === 'test' && decision === 'approved' && deliveryStatus !== 'ready' && options.riskAcceptance === undefined) {
      throw new Error('验收结果包含未通过或阻塞项；请先处理，或使用 task close-with-risk 明确记录风险接受。');
    }
    const artifactHashes = await outputHashes(task, this.deps.taskStore, nodeId);
    const approvalPath = `approvals/${nodeId}/r${node.revision}.yaml`;
    const approval = ApprovalFactSchema.parse({
      nodeId,
      nodeRevision: node.revision,
      artifactHashes,
      decision,
      actor,
      at: new Date().toISOString(),
      ...(note === undefined ? {} : { note }),
    });
    await this.deps.taskStore.createFact(taskId, approvalPath, stringify(approval));
    if (options.riskAcceptance !== undefined) {
      const riskPath = `risk-acceptances/test/r${node.revision}.yaml`;
      await this.deps.taskStore.createFact(taskId, riskPath, stringify({ schemaVersion: 'aiw.risk-acceptance/v1', nodeId: 'test', nodeRevision: node.revision, actor, ...options.riskAcceptance, at: new Date().toISOString() }));
    }
    let next = transitionNode(task, nodeId, { type: 'approve', actor, ...(note === undefined ? {} : { note }) });
    const generatedFacts: Array<{ path: string; content: string }> = [];
    if (decision === 'approved' && nodeId === 'plan') {
      const materialized = await materializeImplementationWork(next, this.deps.taskStore);
      next = materialized.task;
      generatedFacts.push(...materialized.facts);
    }
    if (nodeId === 'test' && decision === 'approved') {
      next.deliveryStatus = options.riskAcceptance === undefined ? 'ready' : 'risk_accepted';
      if (options.riskAcceptance !== undefined) next.events.push({ type: 'close_with_risk', at: new Date().toISOString(), actor, note: options.riskAcceptance.reason });
    }
    next.approvalRefs.push(approvalPath);
    for (const fact of generatedFacts) {
      await this.deps.taskStore.createFact(taskId, fact.path, fact.content);
    }
    await this.deps.taskStore.update(next);
    return next;
  }

  private async assertDecisionRegisterCommitted(taskId: string): Promise<void> {
    const task = await this.deps.taskStore.load(taskId);
    await this.deps.taskFactGuard.assertCommitted({
      task,
      projectRoot: this.deps.taskStore.projectDirectory(),
      paths: ['task.yaml', 'artifacts/decision-register.yaml'],
    });
  }

  private async assertClarifyDecisionsReviewed(taskId: string): Promise<void> {
    if (this.deps.decisionService === undefined) return;
    const pending = (await this.deps.decisionService.list(taskId))
      .filter(({ resolution }) => resolution === undefined)
      .map(({ item }) => item.id);
    if (pending.length > 0) {
      throw new Error(`需求澄清仍有待确认项：${pending.join('、')}；请运行 aiw task review ${taskId}`);
    }
  }
}

export function createTaskStateCommand(deps: { commands: TaskStateCommands; stdout: NodeJS.WriteStream; progress?: ProgressReporter; reviewPrompter?: ReviewPrompter }): Command {
  const command = new Command('task').description('查询任务状态并处理审批');
  command.addCommand(new Command('status').argument('<task-id>').option('--project <path>', '业务仓库根目录；默认当前目录').action(async (taskId: string, _options: unknown, current: Command) => {
    const task = await deps.commands.status(taskId);
    const uncommittedTaskPaths = await deps.commands.uncommittedTaskPaths(taskId);
    const decisions = await optionalDecisions(deps.commands, taskId);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, '任务状态', undefined, decisions, uncommittedTaskPaths));
  }));
  command.addCommand(new Command('review').description('逐项确认需求澄清中的待决策事项，并完成澄清审批').argument('<task-id>').option('--project <path>', '业务仓库根目录；默认当前目录').option('--actor <name>').option('--note <text>', '本次澄清确认说明').action(async (taskId: string, options: { actor?: string; note?: string }, current: Command) => {
    const currentTask = await deps.commands.status(taskId);
    const clarifyStatus = currentTask.nodes.clarify?.status;
    if (clarifyStatus === 'completed') {
      const ready = Object.entries(currentTask.nodes).filter(([, node]) => node.status === 'ready');
      writeCommandResult(currentTask, current, deps.stdout, {
        headline: '需求澄清已确认，无需再次操作',
        details: [{ label: '任务 ID', value: currentTask.id }],
        nextSteps: ready.length === 1
          ? [`aiw task run ${currentTask.id} ${ready[0]![0]}`]
          : ready.length > 1 ? [`aiw task status ${currentTask.id}`] : undefined,
      });
      return;
    }
    if (clarifyStatus !== 'awaiting_approval') {
      throw new Error(`需求澄清当前状态为「${clarifyStatus ?? '不存在'}」，暂时不能确认`);
    }
    const decisions = (await deps.commands.listDecisions(taskId)).filter(({ resolution }) => resolution === undefined);
    const prompter = deps.reviewPrompter ?? createReviewPrompter(deps.stdout);
    const selections = await promptClarifyReview(taskId, decisions, prompter, deps.stdout);
    const task = await deps.commands.reviewClarify(taskId, selections, options);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, '需求澄清已确认', 'chore(aiw): review clarify'));
  }));
  command.addCommand(new Command('migrate-handoffs').description('为旧任务补齐结构化交接包').argument('<task-id>').option('--project <path>', '业务仓库根目录；默认当前目录').action(async (taskId: string, _options: unknown, current: Command) => {
    const { task, migration } = await withProgress({
      reporter: deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr }),
      command: current,
      start: '正在根据历史产物补齐结构化交接包，等待 Codex 完成',
      success: '历史交接包已补齐',
      failure: '历史交接包迁移失败',
      operation: () => deps.commands.migrateHandoffs(taskId),
    });
    const ready = Object.entries(task.nodes).find(([, node]) => node.status === 'ready');
    writeCommandResult(migration, current, deps.stdout, {
      headline: '已补齐结构化交接包',
      details: [
        { label: '任务 ID', value: task.id },
        { label: '迁移批次', value: migration.migrationId },
        { label: '已迁移节点', value: migration.migratedNodeIds.join('、') || '无' },
        { label: '已跳过节点', value: migration.skippedNodeIds.join('、') || '无' },
      ],
      nextSteps: [
        'git add .aiw && git commit -m "chore(aiw): migrate task handoffs"',
        ...(ready === undefined ? [] : [`aiw task run ${task.id} ${ready[0]}`]),
      ],
    });
  }));
  command.addCommand(new Command('decision').description('查看并处理 AI 提出的决策项')
    .addCommand(new Command('list').argument('<task-id>').option('--project <path>', '业务仓库根目录；默认当前目录').action(async (taskId: string, _options: unknown, current: Command) => {
      const decisions = await deps.commands.listDecisions(taskId);
      writeCommandResult(decisions, current, deps.stdout, {
        headline: '待决策事项',
        sections: decisions.map(({ item, resolution }) => ({
          title: `${item.id}：${item.title}`, lines: [
            `影响验收项：${item.affects.acceptanceRefs.join('、')}`,
            `影响工作单元：${item.affects.workUnits.join('、')}`,
            `AI 推荐：${item.recommendation.optionId}（${item.recommendation.rationale}）`,
            `当前选择：${resolution === undefined ? '待选择' : `${resolution.optionId}（${resolution.status}）`}`,
            ...item.options.map((option) => `- ${option.id}：${option.title}；${option.tradeoffs}`),
          ],
        })),
      });
    }))
    .addCommand(new Command('choose').argument('<task-id>').argument('<decision-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--option <id>').option('--note <text>').option('--actor <name>').action(async (taskId: string, decisionId: string, options: { option: string; note?: string; actor?: string }, current: Command) => {
      const task = await deps.commands.chooseDecision(taskId, decisionId, options);
      writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `决策「${decisionId}」已选择`, `chore(aiw): choose ${decisionId}`));
    }))
    .addCommand(new Command('wait').argument('<task-id>').argument('<decision-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--option <id>').requiredOption('--owner <name>').requiredOption('--unblock-condition <text>').option('--note <text>').option('--actor <name>').action(async (taskId: string, decisionId: string, options: { option: string; owner: string; unblockCondition: string; note?: string; actor?: string }, current: Command) => {
      const task = await deps.commands.waitDecision(taskId, decisionId, options);
      writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `决策「${decisionId}」等待外部条件`, `chore(aiw): wait ${decisionId}`));
    }))
    .addCommand(new Command('defer').argument('<task-id>').argument('<decision-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--option <id>').requiredOption('--note <text>').option('--actor <name>').action(async (taskId: string, decisionId: string, options: { option: string; note: string; actor?: string }, current: Command) => {
      const task = await deps.commands.deferDecision(taskId, decisionId, options);
      writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `决策「${decisionId}」已拆期`, `chore(aiw): defer ${decisionId}`));
    }))
    .addCommand(new Command('waive').argument('<task-id>').argument('<decision-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--option <id>').requiredOption('--note <text>').option('--actor <name>').action(async (taskId: string, decisionId: string, options: { option: string; note: string; actor?: string }, current: Command) => {
      const task = await deps.commands.waiveDecision(taskId, decisionId, options);
      writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `决策「${decisionId}」已按风险豁免`, `chore(aiw): waive ${decisionId}`));
    }))
    .addCommand(new Command('resolve').argument('<task-id>').argument('<decision-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--note <text>').option('--actor <name>').action(async (taskId: string, decisionId: string, options: { note: string; actor?: string }, current: Command) => {
      const task = await deps.commands.resolveDecision(taskId, decisionId, options);
      writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `决策「${decisionId}」已解除阻塞`, `chore(aiw): resolve ${decisionId}`));
    })));
  command.addCommand(new Command('approve').argument('<task-id>').argument('<node-id>').option('--project <path>', '业务仓库根目录；默认当前目录').option('--actor <name>').option('--note <text>').action(async (taskId: string, nodeId: string, options: { actor?: string; note?: string }, current: Command) => {
    const task = await deps.commands.approve(taskId, nodeId, options);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `「${nodeId}」节点已批准`, `chore(aiw): approve ${nodeId}`));
  }));
  command.addCommand(new Command('close-with-risk').description('明确接受未通过验收项的风险并关闭测试节点').argument('<task-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--owner <name>').requiredOption('--reason <text>').requiredOption('--expires-at <datetime>').option('--actor <name>').action(async (taskId: string, options: { actor?: string; owner: string; reason: string; expiresAt: string }, current: Command) => {
    const task = await deps.commands.closeWithRisk(taskId, options);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, '测试节点已按风险接受关闭', 'chore(aiw): close test with risk'));
  }));
  command.addCommand(new Command('fail').argument('<task-id>').argument('<node-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--note <text>').option('--actor <name>').action(async (taskId: string, nodeId: string, options: { actor?: string; note: string }, current: Command) => {
    const task = await deps.commands.fail(taskId, nodeId, options);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `「${nodeId}」节点已标记失败`, `chore(aiw): record ${nodeId} failure`));
  }));
  command.addCommand(new Command('cancel').argument('<task-id>').argument('<node-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--note <text>').action(async (taskId: string, nodeId: string, options: { note: string }, current: Command) => {
    const result = await deps.commands.cancel(taskId, nodeId, options);
    writeCommandResult(result, current, deps.stdout, {
      headline: result.status === 'signalled' ? `已向「${nodeId}」发送取消信号` : `已记录「${nodeId}」的取消请求`,
      details: [{ label: '任务 ID', value: taskId }, { label: '运行 ID', value: result.runId }],
      nextSteps: ['等待当前命令结束后，AIW 会保存证据并将节点标记为已取消。'],
    });
  }));
  command.addCommand(new Command('skill').addCommand(new Command('rebind').argument('<task-id>').argument('<node-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--skill <name@version>').requiredOption('--note <text>').action(async (taskId: string, nodeId: string, options: { skill: string; note: string }, current: Command) => {
    const task = await deps.commands.rebindSkill(taskId, nodeId, options);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `「${nodeId}」节点技能已更新`, `chore(aiw): rebind ${nodeId} skill`));
  })));
  command.addCommand(new Command('subtask').description('为复杂实施任务添加可并行子节点')
    .addCommand(new Command('add').argument('<task-id>').argument('<node-id>')
      .option('--project <path>', '业务仓库根目录；默认当前目录')
      .requiredOption('--title <title>', '子任务标题')
      .option('--allowed-path <path>', '允许修改的业务路径；可重复', collect, [])
      .option('--depends-on <node-id>', '依赖节点；可重复，默认 plan', collect, [])
      .option('--before <node-id>', '完成后必须汇合的未开始节点；可重复，默认 verify', collect, [])
      .option('--requires-approval', '子任务完成后等待人工审批')
      .action(async (taskId: string, nodeId: string, options: { title: string; dependsOn: string[]; before: string[]; allowedPath: string[]; requiresApproval?: boolean }, current: Command) => {
        const task = await deps.commands.addSubtask(taskId, nodeId, { ...options, allowedPaths: options.allowedPath, requiresApproval: options.requiresApproval ?? false });
        writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `子任务「${nodeId}」已创建`, `chore(aiw): add ${nodeId} subtask`));
      })));
  return command;
}

function renderTaskOutput(
  task: Task,
  headline: string,
  commitMessage?: string,
  decisions: Awaited<ReturnType<TaskStateCommands['listDecisions']>> = [],
  uncommittedTaskPaths?: string[],
): HumanOutput {
  const ready = Object.entries(task.nodes).find(([, node]) => node.status === 'ready');
  const waiting = Object.entries(task.nodes).find(([, node]) => node.status === 'awaiting_approval');
  const blocked = Object.entries(task.nodes).filter(([, node]) => node.status === 'blocked');
  const failed = Object.entries(task.nodes).find(([, node]) => node.status === 'failed');
  const invalidated = Object.entries(task.nodes).find(([, node]) => node.status === 'invalidated');
  return {
    headline,
    details: [
      { label: '任务 ID', value: task.id },
      { label: '任务名称', value: task.title },
      { label: '整体状态', value: taskStatusLabel(task.status) },
      { label: '交付状态', value: deliveryStatusLabel(task.deliveryStatus) },
    ],
    sections: [
      { title: '节点', lines: Object.entries(task.nodes).map(([nodeId, node]) => `${nodeId}（${node.title}）：${nodeStatusLabel(node.status)}`) },
      ...clarifyDecisionSection(waiting, decisions),
    ],
    nextSteps: ready === undefined && waiting === undefined && blocked.length === 0 && failed === undefined && invalidated === undefined ? undefined : [
      ...(commitMessage === undefined ? [] : [`git add .aiw && git commit -m "${commitMessage}"`]),
      ...(waiting === undefined ? [] : reviewOrApprovalNextSteps(task, waiting, decisions, uncommittedTaskPaths)),
      ...(ready === undefined ? [] : [`aiw task run ${task.id} ${ready[0]}`]),
      ...(blocked.length === 0 ? [] : [`aiw task decision list ${task.id}`]),
      ...(failed === undefined ? [] : [`提交失败证据：git add .aiw && git commit -m "chore(aiw): record ${failed[0]} failure"`, `重试当前节点：aiw task run ${task.id} ${failed[0]}`]),
      ...(invalidated === undefined ? [] : sourceRefreshNextSteps(task)),
    ],
  };
}

function sourceRefreshNextSteps(task: Task): string[] {
  return Object.keys(task.sources).map((sourceId) => `需求来源变更后：aiw task source refresh ${task.id} ${sourceId}`);
}

async function optionalDecisions(commands: TaskStateCommands, taskId: string): Promise<Awaited<ReturnType<TaskStateCommands['listDecisions']>>> {
  try {
    return await commands.listDecisions(taskId);
  } catch {
    return [];
  }
}

function clarifyDecisionSection(
  waiting: [string, TaskNode] | undefined,
  decisions: Awaited<ReturnType<TaskStateCommands['listDecisions']>>,
): Array<NonNullable<HumanOutput['sections']>[number]> {
  if (waiting?.[0] !== 'clarify') return [];
  const outstanding = decisions.filter(({ resolution }) => resolution === undefined);
  if (outstanding.length === 0) return [];
  return [{
    title: `待确认事项（${outstanding.length} 项）`,
    lines: outstanding.map(({ item }) => {
      const recommendation = item.options.find((option) => option.id === item.recommendation.optionId)!;
      return `${item.id}：${item.title}（建议：${recommendation.title}）`;
    }),
  }];
}

function reviewOrApprovalNextSteps(
  task: Task,
  waiting: [string, TaskNode],
  decisions: Awaited<ReturnType<TaskStateCommands['listDecisions']>>,
  uncommittedTaskPaths?: string[],
): string[] {
  if (waiting[0] === 'clarify' && decisions.some(({ resolution }) => resolution === undefined)) {
    return [
      `查看待审批产物：${waiting[1].outputs.map((path) => `.aiw/tasks/${task.id}/${path}`).join('、')}`,
      ...(uncommittedTaskPaths === undefined || uncommittedTaskPaths.length > 0
        ? ['git add .aiw && git commit -m "chore(aiw): record clarify result"']
        : []),
      `aiw task review ${task.id}`,
    ];
  }
  return approvalNextSteps(task, waiting[0], waiting[1], uncommittedTaskPaths);
}

async function promptClarifyReview(
  taskId: string,
  decisions: Awaited<ReturnType<TaskStateCommands['listDecisions']>>,
  prompter: ReviewPrompter,
  stdout: NodeJS.WritableStream,
): Promise<ClarifyDecisionSelection[]> {
  stdout.write(`需求澄清 · 待确认 ${decisions.length} 项\n按序号选择；“自定义结论”可输入补充说明。\n\n`);
  const selections: ClarifyDecisionSelection[] = [];
  for (const [index, { item }] of decisions.entries()) {
    const recommendation = item.options.find((option) => option.id === item.recommendation.optionId)!;
    const alternatives = item.options.filter((option) => option.id !== recommendation.id);
    stdout.write(`[${index + 1}/${decisions.length}] ${item.title}\n`);
    stdout.write(`  原因：${item.recommendation.rationale}\n`);
    stdout.write(`  影响：${item.affects.acceptanceRefs.join('、')} · ${item.affects.workUnits.join('、')}\n`);
    stdout.write(`  推荐\n    1. ${recommendation.title}\n       取舍：${recommendation.tradeoffs}\n`);
    if (alternatives.length > 0) {
      stdout.write('  备选\n');
      alternatives.forEach((option, optionIndex) => stdout.write(`    ${optionIndex + 2}. ${option.title}\n       取舍：${option.tradeoffs}\n`));
    }
    stdout.write(`    ${alternatives.length + 2}. 自定义结论\n`);
    const choices = [recommendation, ...alternatives];
    const answer = await askNumber(prompter, `请输入选择（1-${choices.length + 1}）：`, choices.length + 1);
    if (answer === choices.length + 1) {
      const manualNote = await askRequiredText(prompter, '请输入结论：');
      selections.push({ decisionId: item.id, optionId: 'manual', manualNote });
      stdout.write('\n');
      continue;
    }
    const choice = choices[answer - 1]!;
    if (isExternalWaitOption(choice)) {
      stdout.write('该方案需要等待外部信息。请输入负责团队（直接回车可稍后补充）：\n');
      const owner = (await prompter.ask('等待对象：')).trim() || '待指定';
      selections.push({
        decisionId: item.id,
        optionId: choice.id,
        status: 'waiting_external',
        owner,
        unblockCondition: `已确认：${item.title}`,
      });
    } else {
      selections.push({ decisionId: item.id, optionId: choice.id });
    }
    stdout.write('\n');
  }
  stdout.write('全部事项已处理。是否确认并进入技术方案？\n1. 确认\n2. 暂不确认\n');
  const confirmation = await askNumber(prompter, '请输入选择（1-2）：', 2);
  if (confirmation !== 1) {
    throw new Error(`已取消本次需求澄清确认；本次选择未保存。可重新执行 aiw task review ${taskId}。`);
  }
  return selections;
}

function isExternalWaitOption(option: { id: string; title: string }): boolean {
  return option.id.startsWith('wait-') || /等待/.test(option.title);
}

async function askNumber(prompter: ReviewPrompter, prompt: string, maximum: number): Promise<number> {
  while (true) {
    const answer = Number((await prompter.ask(prompt)).trim());
    if (Number.isInteger(answer) && answer >= 1 && answer <= maximum) return answer;
  }
}

async function askRequiredText(prompter: ReviewPrompter, prompt: string): Promise<string> {
  while (true) {
    const answer = (await prompter.ask(prompt)).trim();
    if (answer.length > 0) return answer;
  }
}

function approvalNextSteps(task: Task, nodeId: string, node: TaskNode, uncommittedTaskPaths?: string[]): string[] {
  const taskDirectory = `.aiw/tasks/${task.id}`;
  const outputPaths = node.outputs.map((path) => `${taskDirectory}/${path}`);
  return [
    `查看待审批产物：${outputPaths.join('、')}`,
    ...(uncommittedTaskPaths === undefined || uncommittedTaskPaths.length > 0
      ? [`git add .aiw && git commit -m "chore(aiw): record ${nodeId} result"`]
      : []),
    `aiw task approve ${task.id} ${nodeId} --note "<审批说明>"`,
  ];
}

function taskStatusLabel(status: Task['status']): string {
  return ({ active: '进行中', partially_blocked: '部分可执行', blocked: '等待处理', completed: '流程已闭环', cancelled: '已取消' })[status];
}

function deliveryStatusLabel(status: Task['deliveryStatus']): string {
  return ({ not_assessed: '尚未评估', ready: '可发布', not_ready: '不可发布', risk_accepted: '风险已接受' })[status];
}

function nodeStatusLabel(status: TaskNode['status']): string {
  return ({ pending: '待开始', blocked: '等待决策', ready: '可执行', running: '运行中', awaiting_approval: '待审批', completed: '已完成', failed: '失败', invalidated: '已失效', cancelled: '已取消', superseded: '已被新版计划替代' })[status];
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function outputHashes(task: Task, taskStore: TaskStore, nodeId: string): Promise<Record<string, string>> {
  const node = task.nodes[nodeId];
  if (node === undefined) {
    throw new Error(`未知节点：${nodeId}`);
  }
  const hashes = await Promise.all(outputPathsForCompletedRun(nodeId, node).map(async (path) => {
    const content = await readFile(taskStore.taskDirectory(task.id) + `/${path}`);
    return [path, `sha256:${createHash('sha256').update(content).digest('hex')}`] as const;
  }));
  return Object.fromEntries(hashes);
}

async function readDeliveryStatus(task: Task, taskStore: TaskStore): Promise<Task['deliveryStatus']> {
  try {
    const results = AcceptanceResultsSchema.parse(parse(await readFile(join(taskStore.taskDirectory(task.id), 'artifacts', 'acceptance-results.yaml'), 'utf8')));
    return deliveryStatusFromAcceptanceResults(results);
  } catch {
    throw new Error('测试节点缺少有效的 artifacts/acceptance-results.yaml');
  }
}

function parseReference(reference: string): [string, string] {
  const match = /^([a-z][a-z0-9-]*)@(\d+\.\d+\.\d+)$/.exec(reference);
  if (match === null) {
    throw new Error('技能引用格式无效');
  }
  return [match[1], match[2]];
}

function lockSkill(skill: { name: string; version: string; registrySource: SkillLock['registrySource']; sha256: string; methodSources: SkillLock['methodSources'] }): SkillLock {
  return { name: skill.name, version: skill.version, registrySource: skill.registrySource, sha256: skill.sha256, methodSources: skill.methodSources };
}
