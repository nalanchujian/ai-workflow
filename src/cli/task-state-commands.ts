import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { Command } from 'commander';

import { ApprovalFactSchema } from '../domain/approval.js';
import type { Task } from '../domain/task.js';
import { materializeDevelopmentWork } from '../services/implementation-work-planner.js';
import { TaskCancellationService } from '../services/task-cancellation-service.js';
import { TaskDecisionService, type ClarifyDecisionSelection } from '../services/task-decision-service.js';
import { TaskFactGuard } from '../services/task-fact-guard.js';
import type { TaskRunLock } from '../services/task-run-lock.js';
import { ignoreDevelopmentNode, transitionNode } from '../services/task-state-machine.js';
import { TaskStore } from '../services/task-store.js';
import { writeCommandResult } from './output.js';
import { createReviewPrompter, type ReviewPrompter } from './review-prompter.js';
import type { ProgressReporter } from './progress-reporter.js';

export class TaskStateCommands {
  constructor(private readonly deps: {
    taskStore: TaskStore;
    taskFactGuard: TaskFactGuard;
    taskLock?: TaskRunLock;
    cancellation?: TaskCancellationService;
    decisionService?: TaskDecisionService;
  }) {}

  status(taskId: string): Promise<Task> { return this.deps.taskStore.load(taskId); }

  pendingDecisions(taskId: string) {
    return (this.deps.decisionService ?? new TaskDecisionService({ taskStore: this.deps.taskStore })).pending(taskId);
  }

  async approve(taskId: string, nodeId: string, options: { actor?: string; note?: string } = {}): Promise<Task> {
    return this.locked(taskId, async () => {
      let task = await this.deps.taskStore.load(taskId);
      const node = task.nodes[nodeId];
      if (node?.status !== 'awaiting_approval') throw new Error('只有待审批节点可以批准');
      const factPaths = [`.aiw/tasks/${task.id}/task.yaml`, ...node.outputs.map((path) => `.aiw/tasks/${task.id}/${path}`)];
      await this.deps.taskFactGuard.assertCommitted({ task, projectRoot: this.deps.taskStore.projectDirectory(), paths: factPaths });
      const actor = await this.deps.taskFactGuard.actor(options.actor);
      const approvalPath = `approvals/${nodeId}.yaml`;
      await this.deps.taskStore.replaceFact(taskId, approvalPath, stringify(ApprovalFactSchema.parse({ nodeId, decision: 'approved', actor, at: new Date().toISOString(), ...(options.note === undefined ? {} : { note: options.note }) })));
      task.approvalRefs = [...new Set([...task.approvalRefs, approvalPath])];
      task = transitionNode(task, nodeId, { type: 'approve', actor, ...(options.note === undefined ? {} : { note: options.note }) });
      if (nodeId === 'plan') task = (await materializeDevelopmentWork(task, this.deps.taskStore)).task;
      return this.deps.taskStore.update(task);
    });
  }

  async reviewClarify(taskId: string, selections: ClarifyDecisionSelection[], options: { actor?: string; note?: string } = {}): Promise<Task> {
    return this.locked(taskId, async () => {
      let task = await this.deps.taskStore.load(taskId);
      if (task.nodes.clarify?.status !== 'awaiting_approval') throw new Error('需求澄清当前不需要确认');
      const clarifyPaths = [
        `.aiw/tasks/${task.id}/task.yaml`,
        ...task.nodes.clarify.outputs.map((path) => `.aiw/tasks/${task.id}/${path}`),
      ];
      await this.deps.taskFactGuard.assertCommitted({ task, projectRoot: this.deps.taskStore.projectDirectory(), paths: clarifyPaths });
      await (this.deps.decisionService ?? new TaskDecisionService({ taskStore: this.deps.taskStore })).apply(taskId, selections);
      const actor = await this.deps.taskFactGuard.actor(options.actor);
      const approvalPath = 'approvals/clarify.yaml';
      await this.deps.taskStore.replaceFact(taskId, approvalPath, stringify(ApprovalFactSchema.parse({ nodeId: 'clarify', decision: 'approved', actor, at: new Date().toISOString(), ...(options.note === undefined ? {} : { note: options.note }) })));
      task.approvalRefs = [...new Set([...task.approvalRefs, approvalPath])];
      task = transitionNode(task, 'clarify', { type: 'approve', actor, ...(options.note === undefined ? {} : { note: options.note }) });
      return this.deps.taskStore.update(task);
    });
  }

  async cancel(taskId: string, nodeId: string, note: string) {
    if (this.deps.cancellation === undefined) throw new Error('当前环境不支持取消运行');
    return this.deps.cancellation.request({ taskId, nodeId, note });
  }

  async ignore(taskId: string, nodeId: string, options: { actor?: string; note: string }): Promise<Task> {
    return this.locked(taskId, async () => {
      const task = await this.deps.taskStore.load(taskId);
      await this.deps.taskFactGuard.assertCommitted({
        task,
        projectRoot: this.deps.taskStore.projectDirectory(),
        paths: [`.aiw/tasks/${task.id}/task.yaml`],
      });
      const actor = await this.deps.taskFactGuard.actor(options.actor);
      return this.deps.taskStore.update(ignoreDevelopmentNode(task, nodeId, options.note, actor));
    });
  }

  async uncommittedTaskPaths(taskId: string): Promise<string[]> {
    const task = await this.deps.taskStore.load(taskId);
    const paths = [
      `.aiw/tasks/${task.id}/task.yaml`,
      ...Object.values(task.nodes).flatMap((node) => node.outputs.map((path) => `.aiw/tasks/${task.id}/${path}`)),
      ...task.approvalRefs.map((path) => `.aiw/tasks/${task.id}/${path}`),
    ];
    return this.deps.taskFactGuard.uncommittedPaths({ task, projectRoot: this.deps.taskStore.projectDirectory(), paths });
  }

  async runBusinessPaths(taskId: string, runId: string): Promise<string[]> {
    try {
      const evidence = JSON.parse(await readFile(join(this.deps.taskStore.taskDirectory(taskId), 'runs', runId, 'change-evidence.json'), 'utf8')) as { changedPaths?: unknown };
      return Array.isArray(evidence.changedPaths) ? evidence.changedPaths.filter((path): path is string => typeof path === 'string') : [];
    } catch { return []; }
  }

  private async locked<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    if (this.deps.taskLock === undefined) return action();
    const lease = await this.deps.taskLock.acquire({ taskId });
    if (lease === undefined) throw new Error('当前任务正在被其他命令修改，请稍后重试');
    try { return await action(); } finally { await lease.release(); }
  }
}

export function createTaskStateCommand(deps: { commands: TaskStateCommands; stdout: NodeJS.WriteStream; progress?: ProgressReporter; reviewPrompter?: ReviewPrompter }): Command {
  const root = new Command('state-internal');
  root.addCommand(new Command('status').description('查看任务当前状态和下一步').argument('<task-id>').action(async (taskId: string, _options: unknown, command: Command) => {
    const task = await deps.commands.status(taskId);
    writeCommandResult(task, command, deps.stdout, statusOutput(task, await nextStepsForTask(deps.commands, task)));
  }));
  root.addCommand(new Command('review').description('逐项确认需求澄清中的待决策事项').argument('<task-id>').action(async (taskId: string, _options: unknown, command: Command) => {
    const task = await deps.commands.status(taskId);
    if (task.nodes.clarify?.status !== 'awaiting_approval') {
      writeCommandResult(task, command, deps.stdout, { headline: '需求澄清当前不需要确认', nextSteps: await nextStepsForTask(deps.commands, task) });
      return;
    }
    const prompter = deps.reviewPrompter ?? createReviewPrompter(deps.stdout);
    const reviewed = await reviewClarifyInteractively(deps.commands, taskId, prompter, deps.stdout);
    writeCommandResult(reviewed, command, deps.stdout, { headline: '需求澄清已确认', nextSteps: await nextStepsForTask(deps.commands, reviewed, 'review clarify') });
  }));
  root.addCommand(new Command('approve').description('批准开发计划').argument('<task-id>').argument('<node-id>').option('--note <text>', '审批说明').action(async (taskId: string, nodeId: string, options: { note?: string }, command: Command) => {
    const task = await deps.commands.approve(taskId, nodeId, options);
    writeCommandResult(task, command, deps.stdout, { headline: `「${nodeId}」节点已批准`, nextSteps: await nextStepsForTask(deps.commands, task, `approve ${nodeId}`) });
  }));
  root.addCommand(new Command('ignore').description('忽略不属于当前任务范围的开发单元').argument('<task-id>').argument('<development-unit-name>', 'development-unit-<英文语义名>').requiredOption('--note <text>', '忽略原因').action(async (taskId: string, nodeId: string, options: { note: string }, command: Command) => {
    const task = await deps.commands.ignore(taskId, nodeId, options);
    writeCommandResult(task, command, deps.stdout, { ...statusOutput(task, await nextStepsForTask(deps.commands, task, `ignore ${nodeId}`)),
      headline: `「${nodeId}」开发单元已忽略`,
    });
  }));
  root.addCommand(new Command('cancel').description('例外：取消正在运行的节点').argument('<task-id>').argument('<node-id>').requiredOption('--note <text>', '取消原因').action(async (taskId: string, nodeId: string, options: { note: string }, command: Command) => {
    const result = await deps.commands.cancel(taskId, nodeId, options.note);
    writeCommandResult(result, command, deps.stdout, { headline: '已请求取消当前运行' });
  }));
  return root;
}

export async function reviewClarifyInteractively(
  commands: Pick<TaskStateCommands, 'pendingDecisions' | 'reviewClarify'>,
  taskId: string,
  prompter: ReviewPrompter,
  stdout: NodeJS.WriteStream,
): Promise<Task> {
  const pending = await commands.pendingDecisions(taskId);
  const selections: ClarifyDecisionSelection[] = [];
  stdout.write(`需求澄清 · 待确认 ${pending.length} 项\n\n`);
  for (const [index, item] of pending.entries()) selections.push(await promptDecision(prompter, stdout, item, index, pending.length));
  return commands.reviewClarify(taskId, selections, { note: '需求澄清已逐项确认' });
}

async function promptDecision(prompter: ReviewPrompter, stdout: NodeJS.WriteStream, item: Awaited<ReturnType<TaskDecisionService['pending']>>[number], index: number, total: number): Promise<ClarifyDecisionSelection> {
  stdout.write(`[${index + 1}/${total}] ${item.question}\n  当前情况：${item.background}\n  影响：${item.impact}\n\n1. 本期继续\n2. 延期处理\n`);
  const action = await askChoice(prompter, '请输入选择（1-2）：', 2);
  if (action === 2) {
    const reason = (await prompter.ask('请输入延期原因：')).trim();
    return { index, action: 'defer', reason: reason || '当前条件不足，后续单独处理' };
  }
  stdout.write('\n本期采用什么方案\n');
  item.options.forEach((option, optionIndex) => stdout.write(`${optionIndex + 1}. ${option.title}${optionIndex === item.recommendation.option ? '（AI 推荐）' : ''}\n   取舍：${option.tradeoffs}\n`));
  const option = (await askChoice(prompter, `请输入选择（1-${item.options.length}）：`, item.options.length)) - 1;
  return { index, action: 'continue', option, rationale: option === item.recommendation.option ? item.recommendation.rationale : item.options[option]!.tradeoffs };
}

async function askChoice(prompter: ReviewPrompter, prompt: string, max: number): Promise<number> {
  while (true) { const value = Number((await prompter.ask(prompt)).trim()); if (Number.isInteger(value) && value >= 1 && value <= max) return value; }
}

function statusOutput(task: Task, guidance: string[] | undefined) {
  const development = Object.values(task.nodes).filter((node) => node.phase === 'development');
  const developmentLines = development.length === 0 ? [] : [
    `总计 ${development.length} 个：已完成 ${development.filter((node) => node.status === 'completed').length}，已忽略 ${development.filter((node) => node.status === 'ignored').length}，可执行 ${development.filter((node) => node.status === 'ready').length}，执行中 ${development.filter((node) => node.status === 'running').length}，失败 ${development.filter((node) => node.status === 'failed').length}，待开始 ${development.filter((node) => ['pending', 'invalidated'].includes(node.status)).length}`,
  ];
  return {
    headline: '任务状态',
    details: [{ label: '任务 ID', value: task.id }, { label: '整体状态', value: taskStatusLabel(task.status) }],
    sections: [
      { title: '节点', lines: Object.entries(task.nodes).map(([id, node]) => `${id}（${node.title}）：${nodeStatusLabel(node.status)}`) },
      ...(developmentLines.length === 0 ? [] : [{ title: '开发进度', lines: developmentLines }]),
    ],
    nextSteps: guidance,
  };
}

export async function nextStepsForTask(commands: Pick<TaskStateCommands, 'uncommittedTaskPaths'>, task: Task, commitMessage = 'record task facts'): Promise<string[] | undefined> {
  const workflowSteps = workflowNextSteps(task) ?? [];
  const uncommitted = await commands.uncommittedTaskPaths(task.id);
  const commitSteps = uncommitted.length === 0
    ? []
    : [`git add .aiw && git commit -m "chore(aiw): ${commitMessage}"`];
  const result = [...commitSteps, ...workflowSteps];
  return result.length === 0 ? undefined : result;
}

export function workflowNextSteps(task: Task): string[] | undefined {
  if (task.status === 'completed' || task.status === 'cancelled') return undefined;
  if (task.nodes.clarify?.status === 'awaiting_approval') return [`aiw task review ${task.id}`];
  const approvals = Object.entries(task.nodes)
    .filter(([, node]) => node.status === 'awaiting_approval')
    .map(([nodeId]) => `aiw task approve ${task.id} ${nodeId} --note "<审批说明>"`);
  if (approvals.length > 0) return approvals;
  const runnable = Object.entries(task.nodes)
    .filter(([, node]) => ['ready', 'failed'].includes(node.status)
      && node.dependsOn.every((dependency) => task.nodes[dependency]?.status === 'completed'))
    .map(([nodeId]) => `aiw task run ${task.id} ${nodeId}`);
  return runnable.length === 0 ? undefined : runnable;
}

function nodeStatusLabel(status: string): string { return ({ pending: '待开始', ready: '可执行', running: '执行中', awaiting_approval: '待确认', completed: '已完成', failed: '失败', invalidated: '需重新执行', cancelled: '已取消', ignored: '已忽略' } as Record<string, string>)[status] ?? status; }
function taskStatusLabel(status: string): string { return ({ active: '进行中', blocked: '等待处理', completed: '开发完成', cancelled: '已取消' } as Record<string, string>)[status] ?? status; }
