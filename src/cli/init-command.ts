import { Command } from 'commander';

import type { DefaultWorkflowBootstrapper } from '../services/default-workflow-bootstrapper.js';
import { writeCommandResult } from './output.js';
import { TerminalProgressReporter, withProgress, type ProgressReporter } from './progress-reporter.js';

export function createInitCommand(deps: { bootstrapper: DefaultWorkflowBootstrapper; progress?: ProgressReporter; stdout: NodeJS.WriteStream }): Command {
  return new Command('init')
    .description('初始化本机 AI Workflow 配置模板')
    .option('--connector-server <name>', '多个文档连接器候选时，指定要使用的 Codex MCP Server 名称')
    .action(async (options: { connectorServer?: string }, command: Command) => {
      const result = await withProgress({
        reporter: deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr }),
        command,
        start: '正在准备本机环境、默认工作流与文档连接器',
        success: '本机环境已就绪',
        failure: '本机初始化失败',
        operation: () => deps.bootstrapper.init(options.connectorServer === undefined ? {} : { connectorServer: options.connectorServer }),
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
    ...(result.connector === undefined ? [] : renderConnectorStatus(result.connector)),
    '',
    '下一步：',
    'aiw task init --project <业务仓库> --source <需求来源>',
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

function renderConnectorStatus(result: NonNullable<Awaited<ReturnType<DefaultWorkflowBootstrapper['init']>>['connector']>): string[] {
  if (result.status === 'configured' || result.status === 'already-configured') {
    return ['文档连接器：可用'];
  }
  if (result.status === 'ambiguous') {
    return [
      '文档连接器：需要选择连接',
      `候选：${result.servers.join('、')}`,
      '执行：aiw init --connector-server <名称>',
    ];
  }
  if (result.status === 'not-found') {
    return ['文档连接器：未连接', '仍可使用本地文件或公开链接创建任务。'];
  }
  if (result.status === 'unsupported') {
    return ['文档连接器：未连接（当前 MCP 不支持读取文档）', '仍可使用本地文件或公开链接创建任务。'];
  }
  return ['文档连接器：暂时无法检测', '仍可使用本地文件或公开链接创建任务。'];
}
