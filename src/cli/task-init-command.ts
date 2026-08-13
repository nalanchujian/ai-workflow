import { Command } from 'commander';

import type { TaskInitializer } from '../services/task-initializer.js';
import { writeResult } from './output.js';

export function createTaskInitCommand(deps: { initializer: TaskInitializer; stdout: NodeJS.WriteStream }): Command {
  return new Command('init')
    .description('使用工作流模板初始化研发任务')
    .argument('<task-id>')
    .requiredOption('--project <path>', '业务仓库根目录')
    .requiredOption('--source <source>', '需求来源：本地文件、公共 URL 或 Lark 文档 URL')
    .requiredOption('--skill-profile <name@version>', '工作流模板')
    .action(async (id: string, options: { project: string; source: string; skillProfile: string }) => {
      const task = await deps.initializer.init({ id, projectRoot: options.project, source: options.source, skillProfile: options.skillProfile });
      writeResult({ taskId: task.id, skillProfile: `${task.skillProfile.name}@${task.skillProfile.version}`, status: task.status }, { json: false, stdout: deps.stdout });
    });
}
