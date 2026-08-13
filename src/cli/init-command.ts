import { Command } from 'commander';

import type { DefaultWorkflowBootstrapper } from '../services/default-workflow-bootstrapper.js';
import { writeCommandResult } from './output.js';

export function createInitCommand(deps: { bootstrapper: DefaultWorkflowBootstrapper; stdout: NodeJS.WriteStream }): Command {
  return new Command('init')
    .description('初始化本机 AI Workflow 配置模板')
    .option('--lark-server <name>', '多个 Lark MCP 候选时，指定要使用的 Codex MCP Server 名称')
    .action(async (options: { larkServer?: string }, command: Command) => {
      const result = await deps.bootstrapper.init(options.larkServer === undefined ? {} : { larkServer: options.larkServer });
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
    ...(result.lark === undefined ? [] : renderLarkStatus(result.lark)),
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
    return ['已更新本机默认工作流配置。'];
  }
  return [];
}

function renderLarkStatus(result: NonNullable<Awaited<ReturnType<DefaultWorkflowBootstrapper['init']>>['lark']>): string[] {
  if (result.status === 'configured' || result.status === 'already-configured') {
    return ['Lark 文档：可用'];
  }
  if (result.status === 'ambiguous') {
    return [
      'Lark 文档：需要选择连接',
      `候选：${result.servers.join('、')}`,
      '执行：aiw init --lark-server <名称>',
    ];
  }
  if (result.status === 'not-found') {
    return ['Lark 文档：未连接', '仍可使用本地文件或公开链接创建任务。'];
  }
  if (result.status === 'unsupported') {
    return ['Lark 文档：未连接（当前 MCP 不支持读取 Lark 文档）', '仍可使用本地文件或公开链接创建任务。'];
  }
  return ['Lark 文档：暂时无法检测', '仍可使用本地文件或公开链接创建任务。'];
}
