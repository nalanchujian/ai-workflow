import { Command } from 'commander';

import type { TaskRunner } from '../services/task-runner.js';
import { writeResult } from './output.js';

export function createTaskRunCommand(deps: { runner: TaskRunner; stdout: NodeJS.WriteStream }): Command {
  return new Command('run')
    .description('运行任务节点')
    .argument('<task-id>')
    .argument('<node-id>')
    .option('--dry-run', '仅生成本机运行上下文，不调用 Codex')
    .option('--include <path>', '额外注入项目内文件', collect, [])
    .action(async (taskId: string, nodeId: string, options: { dryRun?: boolean; include: string[] }) => {
      const result = await deps.runner.run({ taskId, nodeId, dryRun: options.dryRun ?? false, includes: options.include });
      writeResult(result, { json: false, stdout: deps.stdout });
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
