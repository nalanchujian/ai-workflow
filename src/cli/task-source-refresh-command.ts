import { Command } from 'commander';

import { writeCommandResult } from './output.js';
import type { SourceRefresher } from '../services/source-refresher.js';
import { TerminalProgressReporter, withProgress, type ProgressReporter } from './progress-reporter.js';

export function createTaskSourceRefreshCommand(deps: { refresher: SourceRefresher; progress?: ProgressReporter; stdout: NodeJS.WriteStream }): Command {
  return new Command('refresh')
    .description('刷新任务来源快照')
    .argument('<task-id>')
    .argument('<source-id>')
    .option('--project <path>', '业务仓库根目录；默认当前目录')
    .action(async (taskId: string, sourceId: string, _options: unknown, command: Command) => {
      const result = await withProgress({
        reporter: deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr }),
        command,
        start: '正在读取来源并比对需求快照',
        success: '来源快照已检查',
        failure: '来源刷新失败',
        operation: () => deps.refresher.refresh({ taskId, sourceId }),
      });
      writeCommandResult({ changed: result.changed, revision: result.revision, taskId }, command, deps.stdout);
    });
}
