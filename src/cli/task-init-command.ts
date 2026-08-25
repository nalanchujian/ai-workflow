import { Command } from 'commander';

import type { TaskInitializer } from '../services/task-initializer.js';
import { writeCommandResult } from './output.js';
import { TerminalProgressReporter, withProgress, type ProgressReporter } from './progress-reporter.js';

export function createTaskInitCommand(deps: { initializer: TaskInitializer; defaultSkillProfile: () => Promise<string>; progress?: ProgressReporter; stdout: NodeJS.WriteStream }): Command {
  return new Command('init')
    .description('使用工作流模板初始化研发任务')
    .requiredOption('--project <path>', '业务仓库根目录')
    .requiredOption('--source <reference>', '需求文档地址或本地文件路径')
    .option('--section <title>', '可选：只读取文档中指定标题及其子标题内容')
    .option('--design <figma-url>', '可选：在需求澄清前增加独立的 Figma 设计分析节点')
    .option('--skill-profile <name>', '工作流模板；默认使用本机配置')
    .option('--force-new', '即使存在相同未完成需求任务，仍创建新任务')
    .action(async (options: { project: string; source: string; section?: string; design?: string; skillProfile?: string; forceNew?: boolean }, command: Command) => {
      const skillProfile = options.skillProfile ?? await deps.defaultSkillProfile();
      const task = await withProgress({
        reporter: deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr }),
        command,
        start: '正在检查业务仓库并读取需求来源',
        success: '需求已固化，任务已创建',
        failure: '任务初始化失败',
        operation: () => deps.initializer.init({
          projectRoot: options.project,
          source: options.source,
          ...(options.section === undefined ? {} : { section: options.section }),
          ...(options.design === undefined ? {} : { design: options.design }),
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
          `aiw task run ${task.id} ${task.nodes['design-analysis'] === undefined ? 'clarify' : 'design-analysis'}`,
        ],
      });
    });
}
