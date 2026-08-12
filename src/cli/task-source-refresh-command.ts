import { Command } from 'commander';

import { writeResult } from './output.js';
import type { SourceRefresher } from '../services/source-refresher.js';

export function createTaskSourceRefreshCommand(deps: { refresher: SourceRefresher; stdout: NodeJS.WriteStream }): Command {
  return new Command('refresh')
    .description('刷新任务来源快照')
    .argument('<task-id>')
    .argument('<source-id>')
    .action(async (taskId: string, sourceId: string) => {
      const result = await deps.refresher.refresh({ taskId, sourceId });
      writeResult({ changed: result.changed, revision: result.revision, taskId }, { json: false, stdout: deps.stdout });
    });
}
