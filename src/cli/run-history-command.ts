import { Command } from 'commander';

import type { RunHistoryService } from '../services/run-history-service.js';
import { writeCommandResult } from './output.js';

export function createRunHistoryCommand(deps: { history: RunHistoryService; stdout: NodeJS.WriteStream }): Command {
  const command = new Command('run').description('查看和清理本机运行记录');
  command.addCommand(new Command('show')
    .argument('<task-id>')
    .argument('<run-id>')
    .option('--project <path>', '业务仓库，默认当前目录')
    .action(async (taskId: string, runId: string, options: { project?: string }, current: Command) => {
      writeCommandResult(await deps.history.show({ projectRoot: options.project ?? process.cwd(), taskId, runId }), current, deps.stdout);
    }));
  command.addCommand(new Command('prune')
    .option('--older-than <duration>', '保留期，例如 30d', '30d')
    .option('--apply', '实际删除候选运行目录')
    .action(async (options: { olderThan: string; apply?: boolean }, current: Command) => {
      writeCommandResult(await deps.history.prune({ olderThanDays: parseDays(options.olderThan), apply: options.apply ?? false }), current, deps.stdout);
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
