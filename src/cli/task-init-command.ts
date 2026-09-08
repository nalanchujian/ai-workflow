import { Command } from 'commander';

import type { TaskInitializer } from '../services/task-initializer.js';
import { writeCommandResult } from './output.js';
import { TerminalProgressReporter, withProgress, type ProgressReporter } from './progress-reporter.js';

export function createTaskInitCommand(deps: { initializer: TaskInitializer; defaultSkillProfile: () => Promise<string>; progress?: ProgressReporter; stdout: NodeJS.WriteStream }): Command {
  return new Command('init')
    .description('使用工作流模板初始化研发任务')
    .requiredOption('--project <path>', '业务仓库根目录')
    .requiredOption('--source <url>', '需求文档 URL')
    .option('--skill-profile <name>', '工作流模板；默认使用本机配置')
    .option('--force-new', '即使存在相同未完成需求任务，仍创建新任务')
    .action(async (options: { project: string; source: string; skillProfile?: string; forceNew?: boolean }, command: Command) => {
      const skillProfile = options.skillProfile ?? await deps.defaultSkillProfile();
      const task = await withProgress({
        reporter: deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr }),
        command,
        start: '正在检查业务仓库并创建任务',
        success: '任务已创建',
        failure: '任务初始化失败',
        operation: () => deps.initializer.init({
          projectRoot: options.project,
          source: options.source,
          ...(options.forceNew === true ? { forceNew: true } : {}),
          skillProfile,
        }),
      });
      const profile = task.skillProfile.name;
      writeCommandResult({ taskId: task.id, skillProfile: profile, status: task.status }, command, deps.stdout, {
        headline: '任务已创建',
        details: [
          { label: '任务 ID', value: task.id },
          { label: '工作流', value: profile },
          { label: '状态', value: task.status === 'active' ? '进行中' : task.status },
        ],
        nextSteps: [
          'git add .aiw && git commit -m "chore(aiw): initialize task"',
          `aiw task run ${task.id} requirement-analysis`,
        ],
      });
    });
}
