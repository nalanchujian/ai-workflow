import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

const ApprovalFactSchema = z.object({
  nodeId: z.string().min(1),
  nodeRevision: z.number().int().positive(),
  artifactHashes: z.record(z.string(), z.string().regex(/^sha256:[a-f0-9]{64}$/)),
  decision: z.enum(['approved', 'changes_requested']),
  actor: z.string().min(1),
  at: z.string().datetime(),
  note: z.string().optional(),
});

export class TaskStateCommands {
  constructor(private readonly deps: { taskStore: TaskStore; taskFactGuard: TaskFactGuard; skillRegistry?: SkillRegistry; cancellation?: TaskCancellationService; handoffMigrator?: HandoffMigrator; decisionService?: TaskDecisionService }) {}

  async status(taskId: string): Promise<Task> {
    return this.deps.taskStore.load(taskId);
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

  async requestChanges(taskId: string, nodeId: string, options: { actor?: string; note: string }): Promise<Task> {
    return this.decide(taskId, nodeId, 'changes_requested', options);
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

  async revise(taskId: string, nodeId: string, options: { actor?: string; note: string }): Promise<Task> {
    const task = await this.deps.taskStore.load(taskId);
    const next = transitionNode(task, nodeId, { type: 'revise', actor: await this.deps.taskFactGuard.actor(options.actor), note: options.note });
    const node = task.nodes[nodeId];
    if (node === undefined) {
      throw new Error(`未知节点：${nodeId}`);
    }
    await this.deps.taskStore.createFact(taskId, `revisions/${nodeId}/r${node.revision + 1}.md`, `${options.note.trim()}\n`);
    await this.deps.taskStore.update(next);
    return next;
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
    decision: 'approved' | 'changes_requested',
    options: { actor?: string; note?: string; riskAcceptance?: { owner: string; reason: string; expiresAt: string } },
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
    if (decision === 'changes_requested' && (note === undefined || note.length === 0)) {
      throw new Error('变更说明不能为空');
    }
    const completionBundle = await loadRunCompletionBundle(task, this.deps.taskStore, nodeId);
    await this.deps.taskFactGuard.assertCommitted({ task, projectRoot: this.deps.taskStore.projectDirectory(), paths: ['task.yaml', ...completionBundle.paths] });
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
    if (decision === 'changes_requested') {
      await this.deps.taskStore.createFact(taskId, `revisions/${nodeId}/r${node.revision + 1}.md`, `${note}\n`);
    }
    if (options.riskAcceptance !== undefined) {
      const riskPath = `risk-acceptances/test/r${node.revision}.yaml`;
      await this.deps.taskStore.createFact(taskId, riskPath, stringify({ schemaVersion: 'aiw.risk-acceptance/v1', nodeId: 'test', nodeRevision: node.revision, actor, ...options.riskAcceptance, at: new Date().toISOString() }));
    }
    let next = transitionNode(task, nodeId, decision === 'approved'
      ? { type: 'approve', actor, ...(note === undefined ? {} : { note }) }
      : { type: 'request_changes', actor, note: note ?? '' });
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
}

export function createTaskStateCommand(deps: { commands: TaskStateCommands; stdout: NodeJS.WriteStream; progress?: ProgressReporter }): Command {
  const command = new Command('task').description('查询任务状态并处理审批');
  command.addCommand(new Command('status').argument('<task-id>').option('--project <path>', '业务仓库根目录；默认当前目录').action(async (taskId: string, _options: unknown, current: Command) => {
    const task = await deps.commands.status(taskId);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, '任务状态'));
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
  command.addCommand(new Command('request-changes').argument('<task-id>').argument('<node-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--note <text>').option('--actor <name>').action(async (taskId: string, nodeId: string, options: { actor?: string; note: string }, current: Command) => {
    const task = await deps.commands.requestChanges(taskId, nodeId, options);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `「${nodeId}」节点已退回修改`, `chore(aiw): record ${nodeId} changes`));
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
  command.addCommand(new Command('revise').argument('<task-id>').argument('<node-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--note <text>').option('--actor <name>').action(async (taskId: string, nodeId: string, options: { actor?: string; note: string }, current: Command) => {
    const task = await deps.commands.revise(taskId, nodeId, options);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `「${nodeId}」节点已进入修订`, `chore(aiw): record ${nodeId} revision`));
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

function renderTaskOutput(task: Task, headline: string, commitMessage?: string): HumanOutput {
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
    sections: [{ title: '节点', lines: Object.entries(task.nodes).map(([nodeId, node]) => `${nodeId}（${node.title}）：${nodeStatusLabel(node.status)}`) }],
    nextSteps: ready === undefined && waiting === undefined && blocked.length === 0 && failed === undefined && invalidated === undefined ? undefined : [
      ...(commitMessage === undefined ? [] : [`git add .aiw && git commit -m "${commitMessage}"`]),
      ...(waiting === undefined ? [] : approvalNextSteps(task, waiting[0], waiting[1])),
      ...(ready === undefined ? [] : [`aiw task run ${task.id} ${ready[0]}`]),
      ...(blocked.length === 0 ? [] : [`aiw task decision list ${task.id}`]),
      ...(failed === undefined ? [] : [`修正失败原因后：aiw task revise ${task.id} ${failed[0]} --note "<修改说明>"`]),
      ...(invalidated === undefined ? [] : [`上游已变更，请先更新结论：aiw task revise ${task.id} ${invalidated[0]} --note "根据上游变更重新执行"`]),
    ],
  };
}

function approvalNextSteps(task: Task, nodeId: string, node: TaskNode): string[] {
  const taskDirectory = `.aiw/tasks/${task.id}`;
  const outputPaths = node.outputs.map((path) => `${taskDirectory}/${path}`);
  return [
    `查看待审批产物：${outputPaths.join('、')}`,
    `若尚未提交当前产物和状态：git add .aiw && git commit -m "chore(aiw): record ${nodeId} result"`,
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
