import { Command } from 'commander';

import type { TaskRunner } from '../services/task-runner.js';
import { writeCommandResult } from './output.js';
import { TerminalProgressReporter, type ProgressReporter } from './progress-reporter.js';

export function createTaskRunCommand(deps: { runner: TaskRunner; progress?: ProgressReporter; stdout: NodeJS.WriteStream }): Command {
  return new Command('run')
    .description('运行任务节点')
    .argument('<task-id>')
    .argument('<node-id>')
    .option('--project <path>', '业务仓库根目录；默认当前目录')
    .option('--dry-run', '仅生成本机运行上下文，不调用 Codex')
    .option('--include <path>', '额外注入项目内文件', collect, [])
    .action(async (taskId: string, nodeId: string, options: { dryRun?: boolean; include: string[] }, command: Command) => {
      const progress = (deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr })).start(
        command,
        options.dryRun === true ? `正在构建「${nodeId}」节点上下文` : `正在执行「${nodeId}」节点，等待 Codex 完成`,
      );
      let result: Awaited<ReturnType<TaskRunner['run']>>;
      try {
        result = await deps.runner.run({ taskId, nodeId, dryRun: options.dryRun ?? false, includes: options.include });
      } catch (error) {
        progress.fail(`「${nodeId}」节点执行失败`);
        throw error;
      }
      if (result.status === 'succeeded') {
        progress.succeed(options.dryRun === true ? '节点上下文已生成' : `「${nodeId}」节点执行完成`);
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
        nextSteps: result.status === 'succeeded'
          ? [`git add .aiw && git commit -m "chore(aiw): record ${nodeId} result"`, `aiw task status ${taskId}`]
          : [`aiw task status ${taskId}`, `aiw task revise ${taskId} ${nodeId} --note "<修改说明>"`],
      });
    });
}

function runStatusLabel(status: string): string {
  return ({ succeeded: '已完成', failed: '失败', unavailable: '无法执行', cancelled: '已取消' } as Record<string, string>)[status] ?? status;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
