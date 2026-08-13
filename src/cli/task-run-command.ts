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
      writeCommandResult(result, command, deps.stdout);
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
