import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createInitCommand } from '../../src/cli/init-command.js';

describe('init command', () => {
  it('explains the created template and the next actions in default output', async () => {
    let output = '';
    const command = createInitCommand({
      bootstrapper: { async init() { return { schemaVersion: 'aiw.init/v1', status: 'created', configPath: '/home/j/.aiw/config.yaml', workflow: { profile: 'standard-web-feature@2.0.0', source: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.0.0' }, revision: 'revision', status: 'installed' } }; } } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'init']);

    expect(output).toContain('AI Workflow 本机环境已就绪');
    expect(output).toContain('/home/j/.aiw/config.yaml');
    expect(output).toContain('standard-web-feature@2.0.0');
    expect(output).toContain('技能包来源：ai-workflow-skills（Git 标签：v2.0.0）');
    expect(output).toContain('技能状态：已安装');
    expect(output).not.toContain('revision');
    expect(output).toContain('aiw task init --project <业务仓库> --source <需求来源>');
  });

  it('keeps the initialization result machine-readable with --json', async () => {
    let output = '';
    const command = new Command().option('--json').addCommand(createInitCommand({
      bootstrapper: { async init() { return { schemaVersion: 'aiw.init/v1', status: 'already-initialized', configPath: '/home/j/.aiw/config.yaml', workflow: { profile: 'standard-web-feature@2.0.0', source: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.0.0' }, revision: 'revision', status: 'reused' } }; } } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    }));

    await command.parseAsync(['node', 'aiw', '--json', 'init']);

    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 'aiw.init/v1', status: 'already-initialized', configPath: '/home/j/.aiw/config.yaml', workflow: { profile: 'standard-web-feature@2.0.0', status: 'reused' } });
  });
});
