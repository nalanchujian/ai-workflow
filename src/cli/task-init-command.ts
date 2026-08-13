import { Command } from 'commander';

import type { TaskInitializer } from '../services/task-initializer.js';
import { writeCommandResult } from './output.js';

export function createTaskInitCommand(deps: { initializer: TaskInitializer; defaultSkillProfile: () => Promise<string>; stdout: NodeJS.WriteStream }): Command {
  return new Command('init')
    .description('使用工作流模板初始化研发任务')
    .requiredOption('--project <path>', '业务仓库根目录')
    .requiredOption('--source <source>', '需求来源：本地文件、公共 URL 或 Lark 文档 URL')
    .option('--source-section <title>', 'Lark 文档中的需求章节标题；只读取该标题及其子标题内容')
    .option('--skill-profile <name@version>', '工作流模板；默认使用本机配置')
    .option('--force-new', '即使存在相同未完成需求任务，仍创建新任务')
    .action(async (options: { project: string; source: string; sourceSection?: string; skillProfile?: string; forceNew?: boolean }, command: Command) => {
      const skillProfile = options.skillProfile ?? await deps.defaultSkillProfile();
      const task = await deps.initializer.init({
        projectRoot: options.project,
        source: options.source,
        ...(options.sourceSection === undefined ? {} : { sourceSection: options.sourceSection }),
        ...(options.forceNew === true ? { forceNew: true } : {}),
        skillProfile,
      });
      writeCommandResult({ taskId: task.id, skillProfile: `${task.skillProfile.name}@${task.skillProfile.version}`, status: task.status }, command, deps.stdout);
    });
}
