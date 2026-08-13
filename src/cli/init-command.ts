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
  const configMessage = result.status === 'created'
    ? '已创建本机配置模板。'
    : result.status === 'updated'
      ? '已补充本机默认工作流配置。'
      : '已使用现有本机配置。';
  return [
    'AI Workflow 本机环境已就绪',
    '',
    configMessage,
    `位置：${result.configPath}`,
    `默认工作流：${result.workflow.profile}`,
    `技能包：已就绪（${result.workflow.status === 'installed' ? '本次已安装' : '使用本机已安装版本'}）`,
    ...(result.lark === undefined ? [] : [`Lark 文档支持：${renderLarkStatus(result.lark)}`]),
    '',
    '下一步：',
    'aiw task init --project <业务仓库> --source <需求来源>',
  ].join('\n');
}

function renderLarkStatus(result: NonNullable<Awaited<ReturnType<DefaultWorkflowBootstrapper['init']>>['lark']>): string {
  if (result.status === 'configured') {
    return `已就绪（已识别 ${result.server}）`;
  }
  if (result.status === 'already-configured') {
    return '已就绪（使用现有配置）';
  }
  if (result.status === 'not-found') {
    return '未就绪（未发现已配置的 Lark Server）';
  }
  if (result.status === 'ambiguous') {
    return `未就绪（多个候选：${result.servers.join('、')}）`;
  }
  if (result.status === 'unsupported') {
    return '未就绪（未发现支持的文档读取工具）';
  }
  return '未就绪（暂时无法自动检测）';
}
