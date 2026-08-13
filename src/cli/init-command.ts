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
      : '本机配置已存在。';
  return [
    'AI Workflow 本机环境已就绪',
    '',
    configMessage,
    `位置：${result.configPath}`,
    `默认工作流：${result.workflow.profile}`,
    `技能包来源：${repositoryName(result.workflow.source.url)}（Git 标签：${result.workflow.source.ref}）`,
    `技能状态：${result.workflow.status === 'installed' ? '已安装' : '已复用'}`,
    ...(result.lark === undefined ? [] : [`Lark MCP：${renderLarkStatus(result.lark)}`]),
    '',
    '下一步：',
    'aiw task init --project <业务仓库> --source <需求来源>',
  ].join('\n');
}

function renderLarkStatus(result: NonNullable<Awaited<ReturnType<DefaultWorkflowBootstrapper['init']>>['lark']>): string {
  if (result.status === 'configured') {
    return `已自动连接（${result.server}）`;
  }
  if (result.status === 'already-configured') {
    return '已配置';
  }
  if (result.status === 'not-found') {
    return '未发现已配置的 Lark Server';
  }
  if (result.status === 'ambiguous') {
    return `发现多个候选 Server（${result.servers.join('、')}），未自动选择`;
  }
  if (result.status === 'unsupported') {
    return '未发现支持的 Lark 文档读取工具';
  }
  return '暂时无法自动检测';
}

function repositoryName(url: string): string {
  const name = url.split('/').at(-1)?.replace(/\.git$/, '');
  return name === undefined || name.length === 0 ? url : name;
}
