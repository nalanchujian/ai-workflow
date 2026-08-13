import { Command } from 'commander';

import type { RunHistoryService } from '../services/run-history-service.js';
import { writeCommandResult } from './output.js';
import { TerminalProgressReporter, withProgress, type ProgressReporter } from './progress-reporter.js';

export function createRunHistoryCommand(deps: { history: RunHistoryService; progress?: ProgressReporter; stdout: NodeJS.WriteStream }): Command {
  const command = new Command('run').description('查看和清理本机运行记录');
  command.addCommand(new Command('show')
    .argument('<task-id>')
    .argument('<run-id>')
    .option('--project <path>', '业务仓库，默认当前目录')
    .action(async (taskId: string, runId: string, options: { project?: string }, current: Command) => {
      const result = await withProgress({
        reporter: deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr }),
        command: current,
        start: '正在读取运行记录',
        success: '运行记录已读取',
        failure: '读取运行记录失败',
        operation: () => deps.history.show({ projectRoot: options.project ?? process.cwd(), taskId, runId }),
      });
      writeCommandResult(result, current, deps.stdout);
    }));
  command.addCommand(new Command('prune')
    .option('--older-than <duration>', '保留期，例如 30d', '30d')
    .option('--apply', '实际删除候选运行目录')
    .action(async (options: { olderThan: string; apply?: boolean }, current: Command) => {
      const result = await withProgress({
        reporter: deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr }),
        command: current,
        start: options.apply === true ? '正在清理过期运行记录' : '正在扫描过期运行记录',
        success: options.apply === true ? '过期运行记录已清理' : '过期运行记录扫描完成',
        failure: '运行记录清理失败',
        operation: () => deps.history.prune({ olderThanDays: parseDays(options.olderThan), apply: options.apply ?? false }),
      });
      writeCommandResult(result, current, deps.stdout);
    }));
  return command;
}

function parseDays(value: string): number {
  const match = /^(\d+)d$/.exec(value);
  const days = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new Error('`--older-than` 必须是正整数天数，例如 30d');
  }
  return days;
}
