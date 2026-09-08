import { Command } from 'commander';

import type { TaskRunner } from '../services/task-runner.js';
import type { TaskInputService } from '../services/task-input-service.js';
import { workflowNextSteps, type TaskStateCommands } from './task-state-commands.js';
import { writeCommandResult } from './output.js';
import { TerminalProgressReporter, type ProgressReporter } from './progress-reporter.js';

type TaskStateReader = Pick<TaskStateCommands, 'status' | 'uncommittedTaskPaths' | 'runBusinessPaths'>;

export function createTaskRunCommand(deps: { runner: TaskRunner; taskState: TaskStateReader; inputs: TaskInputService; progress?: ProgressReporter; stdout: NodeJS.WriteStream }): Command {
  return new Command('run')
    .description('运行任务节点')
    .argument('<task-id>')
    .argument('<node-name>', '主干节点名或 development-unit-<英文语义名>')
    .option('--project <path>', '业务仓库根目录；默认当前目录')
    .option('--dry-run', '仅生成本机运行上下文，不调用 Codex')
    .option('--include <path>', '额外注入项目内文件', collect, [])
    .option('--requirement-url <url>', '需求分析：Lark docx/wiki 地址')
    .option('--section <name>', '需求分析：可选章节名称')
    .option('--api-url <url>', '接口分析：YApi 文章地址；可重复传入', collect, [])
    .option('--design-image <path>', '设计图切割：本地 PNG/JPEG 路径')
    .option('--skip', '接口分析或设计图切割：忽略本节点资料')
    .action(async (taskId: string, nodeId: string, options: RunOptions, command: Command) => {
      await executeTaskNode(deps, { taskId, nodeId, dryRun: options.dryRun ?? false, includes: options.include, options, command });
    });
}

export async function executeTaskNode(
  deps: { runner: TaskRunner; taskState: TaskStateReader; inputs: TaskInputService; progress?: ProgressReporter; stdout: NodeJS.WriteStream },
  input: { taskId: string; nodeId: string; dryRun: boolean; includes: string[]; options: RunOptions; command: Command },
): Promise<void> {
  const { taskId, nodeId, command } = input;
  const preparation = await prepareNodeInputs(deps, input);
  if (preparation.skipped) {
    const uncommitted = await deps.taskState.uncommittedTaskPaths(taskId);
    writeCommandResult(preparation.task, command, deps.stdout, {
      headline: `「${nodeId}」节点已跳过`,
      details: [{ label: '任务 ID', value: taskId }, { label: '原因', value: preparation.reason }],
      nextSteps: [
        ...(uncommitted.length === 0 ? [] : ['git add .aiw && git commit -m "chore(aiw): record skipped material node"']),
        ...(workflowNextSteps(preparation.task) ?? []),
      ],
    });
    return;
  }
  const progress = (deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr })).start(
    command,
    input.dryRun ? `正在构建「${nodeId}」节点上下文` : `正在执行「${nodeId}」节点，等待 Codex 完成`,
  );
  let result: Awaited<ReturnType<TaskRunner['run']>>;
  let interruptionRequested = false;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (interruptionRequested) return;
    interruptionRequested = true;
    process.stderr.write(`\n收到 ${signal}，正在安全停止「${nodeId}」节点并保存运行证据…\n`);
    void deps.runner.requestCancellation({ taskId, nodeId, reason: `CLI 收到 ${signal}` })
      .catch(() => undefined);
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  try {
    result = await deps.runner.run({ taskId, nodeId, dryRun: input.dryRun, includes: input.includes, ...(preparation.inputsSaved ? { allowUncommittedInputs: true } : {}) });
  } catch (error) {
    progress.fail(`「${nodeId}」节点执行失败`);
    throw error;
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
  }
  if (result.status === 'succeeded') {
    progress.succeed(input.dryRun ? '节点上下文已生成' : `「${nodeId}」节点执行完成`);
  } else {
    progress.fail(`「${nodeId}」节点未完成`);
  }
  writeCommandResult(result, command, deps.stdout, {
    headline: result.status === 'succeeded'
      ? `「${nodeId}」节点已完成`
      : `「${nodeId}」节点未完成`,
    details: [
      { label: '任务 ID', value: taskId },
      { label: '运行 ID', value: result.runId },
      { label: '状态', value: runStatusLabel(result.status) },
      ...(result.artifacts === undefined || result.artifacts.length === 0 ? [] : [{ label: '产物', value: result.artifacts.map((artifact) => artifact.path).join('、') }]),
      ...(result.error === undefined ? [] : [{ label: '原因', value: result.error.message }]),
    ],
    nextSteps: await nextStepsForRun(deps.taskState, taskId, nodeId, result.runId, result.status),
  });
}

async function prepareNodeInputs(
  deps: { taskState: TaskStateReader; inputs: TaskInputService },
  input: { taskId: string; nodeId: string; dryRun: boolean; options: RunOptions },
): Promise<{ skipped: false; inputsSaved: boolean } | { skipped: true; task: Awaited<ReturnType<TaskStateReader['status']>>; reason: string }> {
  const task = await deps.taskState.status(input.taskId);
  const node = task.nodes[input.nodeId];
  if (node === undefined) return { skipped: false, inputsSaved: false };
  const hasMaterialOptions = input.options.requirementUrl !== undefined || input.options.section !== undefined
    || input.options.apiUrl.length > 0 || input.options.designImage !== undefined || input.options.skip === true;
  if (!['requirement-analysis', 'api-analysis', 'design-slicing'].includes(node.phase)) {
    if (hasMaterialOptions) throw new Error('资料参数只支持需求分析、接口分析或设计图切割节点');
    return { skipped: false, inputsSaved: false };
  }
  const unanswered = node.phase === 'requirement-analysis' ? task.inputs.requirement.status === 'not-asked'
    : node.phase === 'api-analysis' ? task.inputs.apiDocuments.status === 'not-asked'
      : task.inputs.design.status === 'not-asked';
  if (!unanswered) {
    if (hasMaterialOptions) throw new Error(`「${input.nodeId}」的资料已记录，不能重复传入`);
    return { skipped: false, inputsSaved: false };
  }
  if (input.dryRun) throw new Error('资料未记录时不能使用 --dry-run；请在本次命令中传入所需资料参数');
  if (node.phase === 'requirement-analysis') {
    if (input.options.skip === true) throw new Error('需求分析不能使用 --skip，必须提供 --requirement-url');
    if (input.options.apiUrl.length > 0 || input.options.designImage !== undefined) throw new Error('需求分析只支持 --requirement-url 和可选的 --section');
    if (input.options.requirementUrl === undefined) throw new Error('需求分析必须提供 --requirement-url <Lark 文档地址>');
    await deps.inputs.saveRequirement(input.taskId, { url: input.options.requirementUrl, ...(input.options.section === undefined ? {} : { section: input.options.section }) });
    return { skipped: false, inputsSaved: true };
  }
  if (node.phase === 'api-analysis') {
    if (input.options.requirementUrl !== undefined || input.options.section !== undefined || input.options.designImage !== undefined) throw new Error('接口分析只支持 --api-url 或 --skip');
    if (input.options.skip === true && input.options.apiUrl.length > 0) throw new Error('接口分析不能同时传入 --api-url 和 --skip');
    if (input.options.skip !== true && input.options.apiUrl.length === 0) throw new Error('接口分析必须提供至少一个 --api-url，或使用 --skip');
    const saved = await deps.inputs.saveApiDocuments(input.taskId, input.options.skip === true ? [] : input.options.apiUrl);
    return saved.skipped ? { skipped: true, task: saved.task, reason: '未提供 YApi 接口文档' } : { skipped: false, inputsSaved: true };
  }
  if (input.options.requirementUrl !== undefined || input.options.section !== undefined || input.options.apiUrl.length > 0) throw new Error('设计图切割只支持 --design-image 或 --skip');
  if (input.options.skip === true && input.options.designImage !== undefined) throw new Error('设计图切割不能同时传入 --design-image 和 --skip');
  if (input.options.skip !== true && input.options.designImage === undefined) throw new Error('设计图切割必须提供 --design-image，或使用 --skip');
  const saved = await deps.inputs.saveDesignImage(input.taskId, input.options.skip === true ? undefined : input.options.designImage);
  return saved.skipped ? { skipped: true, task: saved.task, reason: '未提供设计图' } : { skipped: false, inputsSaved: true };
}

async function nextStepsForRun(
  taskState: TaskStateReader,
  taskId: string,
  nodeId: string,
  runId: string,
  resultStatus: string,
): Promise<string[] | undefined> {
  const task = await taskState.status(taskId);
  const uncommitted = await taskState.uncommittedTaskPaths(taskId);
  const businessPaths = await taskState.runBusinessPaths(taskId, runId);
  const commit = commitSteps(uncommitted, businessPaths, nodeId, resultStatus);
  if (task.status === 'completed') return commit.length === 0 ? undefined : commit;
  const workflow = workflowNextSteps(task) ?? [];
  const result = [...commit, ...workflow];
  return result.length === 0 ? undefined : result;
}

function commitSteps(uncommitted: string[], businessPaths: string[], nodeId: string, resultStatus: string): string[] {
  if (uncommitted.length === 0) return [];
  const message = resultStatus === 'succeeded'
    ? `record ${nodeId} result`
    : resultStatus === 'cancelled' ? `record ${nodeId} cancellation` : `record ${nodeId} failure`;
  if (businessPaths.length === 0) return [`git add .aiw && git commit -m "chore(aiw): ${message}"`];
  const paths = businessPaths.map(shellQuote).join(' ');
  return [
    `检查本次业务改动：git diff -- ${paths}`,
    `git add ${paths} .aiw && git commit -m "chore(aiw): ${message}"`,
  ];
}

function shellQuote(value: string): string {
  return /[^A-Za-z0-9_./-]/.test(value) ? JSON.stringify(value) : value;
}

function runStatusLabel(status: string): string {
  return ({ succeeded: '已完成', failed: '失败', unavailable: '无法执行', cancelled: '已取消' } as Record<string, string>)[status] ?? status;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface RunOptions {
  dryRun?: boolean;
  include: string[];
  requirementUrl?: string;
  section?: string;
  apiUrl: string[];
  designImage?: string;
  skip?: boolean;
}
