import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createInitCommand } from '../../src/cli/init-command.js';

describe('init command', () => {
  it('explains the created template and the next actions in default output', async () => {
    let output = '';
    const command = createInitCommand({
      bootstrapper: { async init() { return { schemaVersion: 'aiw.init/v1', status: 'created', configPath: '/home/j/.aiw/config.yaml', workflow: { profile: 'standard-web-feature', source: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.0.0' }, revision: 'revision', status: 'installed' } }; } } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'init']);

    expect(output).toContain('AI Workflow 已就绪，可以创建任务。');
    expect(output).toContain('/home/j/.aiw/config.yaml');
    expect(output).toContain('standard-web-feature');
    expect(output).toContain('已完成首次本机初始化。');
    expect(output).toContain('默认工作流：standard-web-feature（可用）');
    expect(output).not.toContain('revision');
    expect(output).toContain('aiw task init --project <业务仓库>');
  });

  it('keeps the initialization result machine-readable with --json', async () => {
    let output = '';
    const command = new Command().option('--json').addCommand(createInitCommand({
      bootstrapper: { async init() { return { schemaVersion: 'aiw.init/v1', status: 'already-initialized', configPath: '/home/j/.aiw/config.yaml', workflow: { profile: 'standard-web-feature', source: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.0.0' }, revision: 'revision', status: 'installed' } }; } } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    }));

    await command.parseAsync(['node', 'aiw', '--json', 'init']);

    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 'aiw.init/v1', status: 'already-initialized', configPath: '/home/j/.aiw/config.yaml', workflow: { profile: 'standard-web-feature', status: 'installed' } });
  });

  it('uses user-oriented wording when configuration and skills already exist', async () => {
    let output = '';
    const command = createInitCommand({
      bootstrapper: { async init() { return {
        schemaVersion: 'aiw.init/v1',
        status: 'already-initialized',
        configPath: '/home/j/.aiw/config.yaml',
        workflow: { profile: 'standard-web-feature', source: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.0.0' }, revision: 'revision', status: 'installed' },
      }; } } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'init']);

    expect(output).not.toContain('已使用现有本机配置');
    expect(output).toContain('默认工作流：standard-web-feature（可用）');
    expect(output).toContain('配置位置：/home/j/.aiw/config.yaml');
    expect(output).not.toContain('已复用');
  });

});
