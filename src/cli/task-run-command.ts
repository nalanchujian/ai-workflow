import { Command } from 'commander';

import type { TaskRunner } from '../services/task-runner.js';
import type { TaskStateCommands } from './task-state-commands.js';
import { writeCommandResult } from './output.js';
import { TerminalProgressReporter, type ProgressReporter } from './progress-reporter.js';

type TaskStateReader = Pick<TaskStateCommands, 'status' | 'uncommittedTaskPaths' | 'runBusinessPaths'>;

export function createTaskRunCommand(deps: { runner: TaskRunner; taskState: TaskStateReader; progress?: ProgressReporter; stdout: NodeJS.WriteStream }): Command {
  return new Command('run')
    .description('运行任务节点')
    .argument('<task-id>')
    .argument('<node-id>')
    .option('--project <path>', '业务仓库根目录；默认当前目录')
    .option('--dry-run', '仅生成本机运行上下文，不调用 Codex')
    .option('--include <path>', '额外注入项目内文件', collect, [])
    .action(async (taskId: string, nodeId: string, options: { dryRun?: boolean; include: string[] }, command: Command) => {
      await executeTaskNode(deps, { taskId, nodeId, dryRun: options.dryRun ?? false, includes: options.include, command });
    });
}

export async function executeTaskNode(
  deps: { runner: TaskRunner; taskState: TaskStateReader; progress?: ProgressReporter; stdout: NodeJS.WriteStream },
  input: { taskId: string; nodeId: string; dryRun: boolean; includes: string[]; command: Command },
): Promise<void> {
  const { taskId, nodeId, command } = input;
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
    result = await deps.runner.run({ taskId, nodeId, dryRun: input.dryRun, includes: input.includes });
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

  if (resultStatus !== 'succeeded') {
    return [...commit, `aiw task continue ${taskId}`];
  }

  if (task.status === 'completed') return commit.length === 0 ? undefined : commit;
  return [...commit, `aiw task continue ${taskId}`];
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
