import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Command } from 'commander';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { type Task, type TaskNode } from '../domain/task.js';
import { ApprovalFactSchema } from '../domain/approval.js';
import { outputPathsForCompletedRun } from '../domain/handoff.js';
import { TaskFactGuard } from '../services/task-fact-guard.js';
import { invalidateNodeAndDependents, transitionNode } from '../services/task-state-machine.js';
import { TaskStore } from '../services/task-store.js';
import { loadRunCompletionBundle } from '../services/run-completion-bundle.js';
import { TaskCancellationService } from '../services/task-cancellation-service.js';
import { materializeImplementationWork, readWorkBreakdown, validatePlanAcceptanceCoverage } from '../services/implementation-work-planner.js';
import { TaskDecisionService } from '../services/task-decision-service.js';
import { AcceptanceResultsSchema, deliveryStatusFromAcceptanceResults } from '../domain/acceptance-results.js';
import { AcceptanceCatalogSchema } from '../domain/acceptance-catalog.js';
import { type HumanOutput, writeCommandResult } from './output.js';
import { type ProgressReporter } from './progress-reporter.js';
import { createReviewPrompter, type ReviewPrompter } from './review-prompter.js';

type ClarifyDecisionSelection = {
  decisionId: string;
  optionId: string;
  status?: 'resolved' | 'waiting_external' | 'deferred' | 'waived';
  owner?: string;
  unblockCondition?: string;
  manualNote?: string;
};

type AcceptanceDetail = { id: string; title: string; description: string };

export class TaskStateCommands {
  constructor(private readonly deps: { taskStore: TaskStore; taskFactGuard: TaskFactGuard; cancellation?: TaskCancellationService; decisionService?: TaskDecisionService }) {}

  async status(taskId: string): Promise<Task> {
    return this.deps.taskStore.load(taskId);
  }

  async acceptanceCoverageSummary(taskId: string): Promise<NonNullable<HumanOutput['sections']>[number]> {
    const task = await this.deps.taskStore.load(taskId);
    const breakdown = await readWorkBreakdown(task, this.deps.taskStore);
    const labels = {
      implement: '本期实施',
      waiting_external: '等待外部条件',
      deferred: '拆至后续范围',
      waived: '风险豁免',
    } as const;
    return {
      title: '验收覆盖',
      lines: (Object.keys(labels) as Array<keyof typeof labels>).map((disposition) => {
        const items = breakdown.acceptanceCoverage.filter((item) => item.disposition === disposition).map((item) => item.acceptanceId);
        return `${labels[disposition]}：${items.length === 0 ? '无' : items.join('、')}`;
      }),
    };
  }

  async acceptanceDetails(taskId: string): Promise<Map<string, AcceptanceDetail>> {
    const task = await this.deps.taskStore.load(taskId);
    const content = await readFile(join(this.deps.taskStore.taskDirectory(task.id), 'artifacts', 'acceptance.yaml'), 'utf8');
    const catalog = AcceptanceCatalogSchema.parse(parse(content));
    return new Map(catalog.items.map((item) => [item.id, item]));
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

  async runBusinessPaths(taskId: string, runId: string): Promise<string[]> {
    try {
      const content = await readFile(join(this.deps.taskStore.taskDirectory(taskId), 'runs', runId, 'change-diff.json'), 'utf8');
      const record = z.object({ changedPaths: z.array(z.string()) }).parse(JSON.parse(content));
      return record.changedPaths.filter((path) => !path.startsWith('.aiw/'));
    } catch {
      return [];
    }
  }

  async listDecisions(taskId: string) {
    if (this.deps.decisionService === undefined) throw new Error('当前环境不支持决策管理');
    return this.deps.decisionService.list(taskId);
  }

  async resolveDecision(taskId: string, decisionId: string, options: { note: string; actor?: string }): Promise<Task> {
    if (this.deps.decisionService === undefined) throw new Error('当前环境不支持决策管理');
    await this.assertDecisionRegisterCommitted(taskId);
    return this.deps.decisionService.resolve({ taskId, decisionId, actor: await this.deps.taskFactGuard.actor(options.actor), note: options.note });
  }

  async approve(taskId: string, nodeId: string, options: { actor?: string; note?: string }): Promise<Task> {
    if (nodeId === 'clarify') {
      throw new Error(`需求澄清请使用 aiw task review ${taskId}`);
    }
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
    const completionBundle = await this.completionBundleOrInvalidate(task, 'clarify');
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

  async cancel(taskId: string, nodeId: string, options: { note: string }): Promise<{ taskId: string; nodeId: string; runId: string; status: 'requested' | 'signalled' }> {
    if (this.deps.cancellation === undefined) throw new Error('当前环境不支持取消运行');
    return this.deps.cancellation.request({ taskId, nodeId, note: options.note.trim() });
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
    const completionBundle = await this.completionBundleOrInvalidate(task, nodeId);
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
    if (nodeId === 'plan' && decision === 'approved') {
      await validatePlanAcceptanceCoverage(task, this.deps.taskStore);
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

  private async completionBundleOrInvalidate(task: Task, nodeId: string) {
    try {
      return await loadRunCompletionBundle(task, this.deps.taskStore, nodeId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : '节点 ' + nodeId + ' 的运行完成包无法验证';
      await this.deps.taskStore.update(invalidateNodeAndDependents(task, nodeId, '完成产物完整性校验失败：' + reason));
      throw error;
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
  command.addCommand(new Command('review').description('逐项确认需求澄清中的待决策事项，并完成澄清审批').argument('<task-id>').option('--project <path>', '业务仓库根目录；默认当前目录').option('--actor <name>').option('--note <text>', '本次澄清确认说明').option('--confirm', '无待确认事项时直接确认需求澄清').action(async (taskId: string, options: { actor?: string; note?: string; confirm?: boolean }, current: Command) => {
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
    if (options.confirm === true && decisions.length > 0) {
      throw new Error('存在待确认事项时不能使用 --confirm；请逐项执行 task review');
    }
    const acceptanceDetails = await optionalAcceptanceDetails(deps.commands, taskId);
    const selections = options.confirm === true ? [] : await promptClarifyReview(taskId, decisions, prompter, deps.stdout, acceptanceDetails);
    const task = await deps.commands.reviewClarify(taskId, selections, options);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, '需求澄清已确认', 'chore(aiw): review clarify'));
  }));
  command.addCommand(new Command('decision').description('高级：查看决策项，或解除已满足的外部等待')
    .addCommand(new Command('list').argument('<task-id>').option('--project <path>', '业务仓库根目录；默认当前目录').action(async (taskId: string, _options: unknown, current: Command) => {
      const decisions = await deps.commands.listDecisions(taskId);
      writeCommandResult(decisions, current, deps.stdout, {
        headline: '待决策事项',
        sections: decisions.map(({ item, resolution }) => ({
          title: `${item.id}：${item.title}`, lines: [
            `影响验收项：${item.affects.acceptanceRefs[0]}`,
            `影响工作单元：${item.affects.workUnits.join('、')}`,
            `AI 推荐：${item.recommendation.optionId}（${item.recommendation.rationale}）`,
            `当前选择：${resolution === undefined ? '待选择' : `${resolution.optionId}（${resolution.status}）`}`,
            ...item.options.map((option) => `- ${option.id}：${option.title}；${option.tradeoffs}；结果：${decisionEffectLabel(option.effect)}`),
          ],
        })),
      });
    }))
    .addCommand(new Command('resolve').description('例外：外部等待条件满足后解除阻塞').argument('<task-id>').argument('<decision-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--note <text>').option('--actor <name>').action(async (taskId: string, decisionId: string, options: { note: string; actor?: string }, current: Command) => {
      const task = await deps.commands.resolveDecision(taskId, decisionId, options);
      writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `决策「${decisionId}」已解除阻塞`, `chore(aiw): resolve ${decisionId}`));
    })));
  command.addCommand(new Command('approve').argument('<task-id>').argument('<node-id>').option('--project <path>', '业务仓库根目录；默认当前目录').option('--actor <name>').option('--note <text>').action(async (taskId: string, nodeId: string, options: { actor?: string; note?: string }, current: Command) => {
    const task = await deps.commands.approve(taskId, nodeId, options);
    const coverageSection = nodeId === 'plan' ? await deps.commands.acceptanceCoverageSummary(taskId) : undefined;
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `「${nodeId}」节点已批准`, `chore(aiw): approve ${nodeId}`, [], undefined, coverageSection));
  }));
  command.addCommand(new Command('close-with-risk').description('例外：接受未通过验收项的风险并关闭测试节点').argument('<task-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--owner <name>').requiredOption('--reason <text>').requiredOption('--expires-at <datetime>').option('--actor <name>').action(async (taskId: string, options: { actor?: string; owner: string; reason: string; expiresAt: string }, current: Command) => {
    const task = await deps.commands.closeWithRisk(taskId, options);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, '测试节点已按风险接受关闭', 'chore(aiw): close test with risk'));
  }));
  command.addCommand(new Command('cancel').description('例外：取消正在运行的节点').argument('<task-id>').argument('<node-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--note <text>').action(async (taskId: string, nodeId: string, options: { note: string }, current: Command) => {
    const result = await deps.commands.cancel(taskId, nodeId, options);
    writeCommandResult(result, current, deps.stdout, {
      headline: result.status === 'signalled' ? `已向「${nodeId}」发送取消信号` : `已记录「${nodeId}」的取消请求`,
      details: [{ label: '任务 ID', value: taskId }, { label: '运行 ID', value: result.runId }],
      nextSteps: ['等待当前命令结束后，AIW 会保存证据并将节点标记为已取消。'],
    });
  }));
  return command;
}

function renderTaskOutput(
  task: Task,
  headline: string,
  commitMessage?: string,
  decisions: Awaited<ReturnType<TaskStateCommands['listDecisions']>> = [],
  uncommittedTaskPaths?: string[],
  extraSection?: NonNullable<HumanOutput['sections']>[number],
): HumanOutput {
  const ready = Object.entries(task.nodes).filter(([, node]) => node.status === 'ready');
  const waiting = Object.entries(task.nodes).find(([, node]) => node.status === 'awaiting_approval');
  const blocked = Object.entries(task.nodes).filter(([, node]) => node.status === 'blocked');
  const failed = Object.entries(task.nodes).find(([, node]) => node.status === 'failed');
  const cancelled = Object.entries(task.nodes).find(([, node]) => node.status === 'cancelled');
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
      ...nodeSections(task),
      ...clarifyDecisionSection(waiting, decisions),
      ...(extraSection === undefined ? [] : [extraSection]),
    ],
    nextSteps: ready.length === 0 && waiting === undefined && blocked.length === 0 && failed === undefined && cancelled === undefined && invalidated === undefined ? undefined : [
      ...(commitMessage === undefined ? [] : [`git add .aiw && git commit -m "${commitMessage}"`]),
      ...(waiting === undefined ? [] : reviewOrApprovalNextSteps(task, waiting, decisions, uncommittedTaskPaths)),
      ...(ready.length === 0 ? [] : ready.length === 1 ? [`aiw task run ${task.id} ${ready[0]![0]}`] : ready.map(([nodeId, node]) => `执行「${node.title}」：aiw task run ${task.id} ${nodeId}`)),
      ...(blocked.length === 0 ? [] : [`aiw task decision list ${task.id}`]),
      ...(failed === undefined ? [] : [
        ...(uncommittedTaskPaths === undefined || uncommittedTaskPaths.length > 0 ? [`git add .aiw && git commit -m "chore(aiw): record ${failed[0]} failure"`] : []),
        `重试「${failed[1].title}」：aiw task run ${task.id} ${failed[0]}`,
      ]),
      ...(cancelled === undefined ? [] : [
        ...(uncommittedTaskPaths === undefined || uncommittedTaskPaths.length > 0 ? [`git add .aiw && git commit -m "chore(aiw): record ${cancelled[0]} cancellation"`] : []),
        `重新执行「${cancelled[1].title}」：aiw task run ${task.id} ${cancelled[0]}`,
      ]),
      ...(invalidated === undefined ? [] : invalidatedNextSteps(task)),
    ],
  };
}

function invalidatedNextSteps(task: Task): string[] {
  const candidates = Object.entries(task.nodes)
    .filter(([, node]) => node.status === 'invalidated')
    .filter(([, node]) => node.dependsOn.every((dependency) => task.nodes[dependency]?.status !== 'invalidated'));
  const [nodeId, node] = candidates[0] ?? Object.entries(task.nodes).find(([, item]) => item.status === 'invalidated')!;
  return [`重新执行已失效节点「${node.title}」：aiw task run ${task.id} ${nodeId}`];
}

function nodeSections(task: Task): Array<NonNullable<HumanOutput['sections']>[number]> {
  const units = Object.entries(task.nodes).filter(([, node]) => node.phase === 'implement' && node.generatedFromPlanRevision !== undefined && node.status !== 'superseded');
  const split = units.length > 1;
  const ordinary = Object.entries(task.nodes).filter(([nodeId, node]) => !split || (node.phase !== 'implement' && nodeId !== 'implement'));
  return [
    { title: '节点', lines: ordinary.map(([nodeId, node]) => `${nodeId}（${node.title}）：${nodeStatusLabel(node.status)}`) },
    ...(split ? [{ title: `实施单元（${units.length}）`, lines: units.map(([nodeId, node]) => `${node.title}：${nodeStatusLabel(node.status)}（${nodeId}）`) }] : []),
  ];
}

async function optionalDecisions(commands: TaskStateCommands, taskId: string): Promise<Awaited<ReturnType<TaskStateCommands['listDecisions']>>> {
  try {
    return await commands.listDecisions(taskId);
  } catch {
    return [];
  }
}

async function optionalAcceptanceDetails(commands: TaskStateCommands, taskId: string): Promise<Map<string, AcceptanceDetail>> {
  try {
    return await commands.acceptanceDetails(taskId);
  } catch {
    return new Map();
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
  if (waiting[0] === 'clarify') {
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
  acceptanceDetails: Map<string, AcceptanceDetail>,
): Promise<ClarifyDecisionSelection[]> {
  stdout.write(`需求澄清 · 待确认 ${decisions.length} 项\n先确定本期处理方式；选择“本期继续”后再选择业务结论。\n\n`);
  const selections: ClarifyDecisionSelection[] = [];
  for (const [index, { item }] of decisions.entries()) {
    stdout.write(`[${index + 1}/${decisions.length}] ${item.title}\n`);
    writeDecisionContext(item, acceptanceDetails, stdout);
    stdout.write('  本期如何处理\n    1. 本期继续\n    2. 等待外部条件\n');
    const handling = await askNumber(prompter, '请输入选择（1-2）：', 2);
    if (handling === 2) {
      selections.push({
        decisionId: item.id,
        optionId: 'manual',
        status: 'waiting_external',
        owner: '待指定',
        unblockCondition: `已确认：${item.title}`,
        manualNote: '人工选择等待外部条件。',
      });
      stdout.write('\n');
      continue;
    }
    const continued = continuationOptions(item);
    stdout.write('  本期采用什么结论\n');
    continued.forEach((option, optionIndex) => {
      const recommendation = option.id === item.recommendation.optionId ? '（AI 推荐）' : '（AI 备选）';
      stdout.write(`    ${optionIndex + 1}. ${option.title}${recommendation}\n       取舍：${option.tradeoffs}\n`);
    });
    const manualChoice = continued.length + 1;
    stdout.write(`    ${manualChoice}. 人工输入结论\n`);
    const answer = await askNumber(prompter, `请输入选择（1-${manualChoice}）：`, manualChoice);
    if (answer === manualChoice) {
      const manualNote = await askRequiredText(prompter, '请输入本期实施结论：');
      selections.push({ decisionId: item.id, optionId: 'manual', status: 'resolved', manualNote });
    } else {
      selections.push({ decisionId: item.id, optionId: continued[answer - 1]!.id, status: 'resolved' });
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

function writeDecisionContext(
  item: Awaited<ReturnType<TaskStateCommands['listDecisions']>>[number]['item'],
  acceptanceDetails: Map<string, AcceptanceDetail>,
  stdout: NodeJS.WritableStream,
): void {
  const detail = item.detail;
  stdout.write('  待确认：');
  if (detail !== undefined) {
    stdout.write(`${detail.question}\n`);
    stdout.write(`  当前情况：${detail.background}\n`);
    stdout.write(`  不确认的影响：${detail.impact}\n`);
  } else {
    stdout.write(`${item.title}\n`);
    stdout.write(`  当前情况：${item.recommendation.rationale}\n`);
    stdout.write(`  不确认的影响：${item.affects.acceptanceRefs[0]} 的验收与 ${item.affects.workUnits.join('、')} 的实施边界无法可靠确定。\n`);
  }
  const acceptance = acceptanceDetails.get(item.affects.acceptanceRefs[0]!);
  if (acceptance !== undefined) {
    stdout.write(`  关联验收项：${acceptance.id}：${acceptance.title}\n    验收标准：${acceptance.description}\n`);
  }
  stdout.write('\n');
}

function continuationOptions(item: Awaited<ReturnType<TaskStateCommands['listDecisions']>>[number]['item']) {
  const candidates = item.options.filter((option) => option.effect === 'resolved');
  const recommendation = candidates.find((option) => option.id === item.recommendation.optionId);
  return [
    ...(recommendation === undefined ? [] : [recommendation]),
    ...candidates.filter((option) => option.id !== recommendation?.id),
  ].slice(0, 2);
}

async function askNumber(prompter: ReviewPrompter, prompt: string, maximum: number): Promise<number> {
  while (true) {
    const answer = Number((await prompter.ask(prompt)).trim());
    if (Number.isInteger(answer) && answer >= 1 && answer <= maximum) return answer;
  }
}

function decisionEffectLabel(effect: 'resolved' | 'waiting_external' | 'deferred' | 'waived'): string {
  switch (effect) {
    case 'resolved': return '本期继续实施';
    case 'waiting_external': return '等待外部条件，仅阻塞关联实施单元';
    case 'deferred': return '拆至后续范围，移除关联实施单元';
    case 'waived': return '接受已知风险，继续实施';
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
