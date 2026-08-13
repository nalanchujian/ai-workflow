import { Command } from 'commander';

import type { LocalInitializer } from '../services/local-initializer.js';
import { writeCommandResult } from './output.js';

export function createInitCommand(deps: { initializer: LocalInitializer; stdout: NodeJS.WriteStream }): Command {
  return new Command('init')
    .description('初始化本机 AI Workflow 配置模板')
    .action(async (_options: unknown, command: Command) => {
      const result = await deps.initializer.init();
      if (command.optsWithGlobals().json) {
        writeCommandResult(result, command, deps.stdout);
        return;
      }
      deps.stdout.write(`${renderInitResult(result)}\n`);
    });
}

function renderInitResult(result: Awaited<ReturnType<LocalInitializer['init']>>): string {
  if (result.status === 'already-initialized') {
    return [
      '本机配置已存在，未做任何修改',
      '',
      `位置：${result.configPath}`,
    ].join('\n');
  }
  return [
    '已创建本机配置模板',
    '',
    `位置：${result.configPath}`,
    '用途：仅用于可选的 Lark MCP 连接配置。',
    '不包含：密钥、Superpowers 配置、团队技能或项目文件。',
    '',
    '下一步：',
    '1. 安装团队技能：aiw skills install <团队技能仓库> --ref <版本>',
    '2. 检查环境：aiw doctor --project <业务仓库>',
  ].join('\n');
}
