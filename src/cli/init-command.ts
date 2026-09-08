import { Command } from 'commander';

import type { DefaultWorkflowBootstrapper } from '../services/default-workflow-bootstrapper.js';
import { writeCommandResult } from './output.js';
import { TerminalProgressReporter, withProgress, type ProgressReporter } from './progress-reporter.js';

export function createInitCommand(deps: { bootstrapper: DefaultWorkflowBootstrapper; progress?: ProgressReporter; stdout: NodeJS.WriteStream }): Command {
  return new Command('init')
    .description('初始化本机 AI Workflow 配置模板')
    .action(async (_options: Record<string, never>, command: Command) => {
      const result = await withProgress({
        reporter: deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr }),
        command,
        start: '正在准备本机环境与默认工作流',
        success: '本机环境已就绪',
        failure: '本机初始化失败',
        operation: () => deps.bootstrapper.init(),
      });
      if (command.optsWithGlobals().json) {
        writeCommandResult(result, command, deps.stdout);
        return;
      }
      deps.stdout.write(`${renderInitResult(result)}\n`);
    });
}

function renderInitResult(result: Awaited<ReturnType<DefaultWorkflowBootstrapper['init']>>): string {
  return [
    'AI Workflow 已就绪，可以创建任务。',
    '',
    ...renderInitializationMessage(result.status),
    `默认工作流：${result.workflow.profile}（可用）`,
    '',
    '下一步：',
    'aiw task init --project <业务仓库>',
    '',
    `配置位置：${result.configPath}`,
  ].join('\n');
}

function renderInitializationMessage(status: Awaited<ReturnType<DefaultWorkflowBootstrapper['init']>>['status']): string[] {
  if (status === 'created') {
    return ['已完成首次本机初始化。'];
  }
  if (status === 'updated') {
    return ['已补充本机默认配置。'];
  }
  return [];
}
