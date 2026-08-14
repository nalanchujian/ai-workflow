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
      writeCommandResult(result, current, deps.stdout, {
        headline: result.status === 'succeeded' ? '运行记录：已完成' : `运行记录：${runStatusLabel(result.status)}`,
        details: [
          { label: '任务 ID', value: result.taskId },
          { label: '运行 ID', value: result.runId },
          ...(result.context.nodeId === undefined ? [] : [{ label: '节点', value: result.context.nodeId }]),
          ...(result.context.fileCount === undefined ? [] : [{ label: '上下文', value: `${result.context.fileCount} 个文件，约 ${result.context.estimatedTokens}/${result.context.maxTokens} tokens` }]),
          ...(result.error === undefined ? [] : [{ label: '失败原因', value: result.error.message }]),
        ],
        sections: [{ title: '本机日志', lines: result.logs.map((log) => `${log.kind}：${log.available ? log.path : '未生成'}`) }],
      });
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
      writeCommandResult(result, current, deps.stdout, {
        headline: result.apply ? `已清理 ${result.deleted.length} 个过期运行目录` : `发现 ${result.candidates.length} 个过期运行目录`,
        details: [{ label: '保留期', value: `${result.olderThanDays} 天` }],
        sections: result.candidates.length === 0 ? undefined : [{ title: '候选记录', lines: result.candidates.map((candidate) => `${candidate.taskId}/${candidate.runId}`) }],
        nextSteps: result.apply || result.candidates.length === 0 ? undefined : [`aiw run prune --older-than ${result.olderThanDays}d --apply`],
      });
    }));
  return command;
}

function runStatusLabel(status: string): string {
  return ({ failed: '失败', unavailable: '无法执行', cancelled: '已取消' } as Record<string, string>)[status] ?? status;
}

function parseDays(value: string): number {
  const match = /^(\d+)d$/.exec(value);
  const days = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new Error('`--older-than` 必须是正整数天数，例如 30d');
  }
  return days;
}
