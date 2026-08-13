import { Command } from 'commander';

import type { DefaultWorkflowBootstrapper } from '../services/default-workflow-bootstrapper.js';
import { writeCommandResult } from './output.js';

export function createInitCommand(deps: { bootstrapper: DefaultWorkflowBootstrapper; stdout: NodeJS.WriteStream }): Command {
  return new Command('init')
    .description('初始化本机 AI Workflow 配置模板')
    .action(async (_options: unknown, command: Command) => {
      const result = await deps.bootstrapper.init();
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
    '',
    '下一步：',
    'aiw task init --project <业务仓库> --source <需求来源>',
  ].join('\n');
}

function repositoryName(url: string): string {
  const name = url.split('/').at(-1)?.replace(/\.git$/, '');
  return name === undefined || name.length === 0 ? url : name;
}
