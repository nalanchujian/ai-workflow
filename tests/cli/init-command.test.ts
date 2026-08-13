import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createInitCommand } from '../../src/cli/init-command.js';

describe('init command', () => {
  it('explains the created template and the next actions in default output', async () => {
    let output = '';
    const command = createInitCommand({
      initializer: { async init() { return { schemaVersion: 'aiw.init/v1', status: 'created', configPath: '/home/j/.aiw/config.yaml' }; } } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'init']);

    expect(output).toContain('已创建本机配置模板');
    expect(output).toContain('/home/j/.aiw/config.yaml');
    expect(output).toContain('仅用于可选的 Lark MCP 连接配置');
    expect(output).toContain('不包含：密钥、Superpowers 配置、团队技能或项目文件');
    expect(output).toContain('aiw skills install <团队技能仓库> --ref <版本>');
    expect(output).toContain('aiw doctor --project <业务仓库>');
  });

  it('keeps the initialization result machine-readable with --json', async () => {
    let output = '';
    const command = new Command().option('--json').addCommand(createInitCommand({
      initializer: { async init() { return { schemaVersion: 'aiw.init/v1', status: 'already-initialized', configPath: '/home/j/.aiw/config.yaml' }; } } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    }));

    await command.parseAsync(['node', 'aiw', '--json', 'init']);

    expect(JSON.parse(output)).toEqual({ schemaVersion: 'aiw.init/v1', status: 'already-initialized', configPath: '/home/j/.aiw/config.yaml' });
  });
});
