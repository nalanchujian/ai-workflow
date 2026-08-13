import { Command } from 'commander';

import type { TaskInitializer } from '../services/task-initializer.js';
import { writeCommandResult } from './output.js';

export function createTaskInitCommand(deps: { initializer: TaskInitializer; stdout: NodeJS.WriteStream }): Command {
  return new Command('init')
    .description('使用工作流模板初始化研发任务')
    .requiredOption('--project <path>', '业务仓库根目录')
    .requiredOption('--source <source>', '需求来源：本地文件、公共 URL 或 Lark 文档 URL')
    .requiredOption('--skill-profile <name@version>', '工作流模板')
    .action(async (options: { project: string; source: string; skillProfile: string }, command: Command) => {
      const task = await deps.initializer.init({ projectRoot: options.project, source: options.source, skillProfile: options.skillProfile });
      writeCommandResult({ taskId: task.id, skillProfile: `${task.skillProfile.name}@${task.skillProfile.version}`, status: task.status }, command, deps.stdout);
    });
}
