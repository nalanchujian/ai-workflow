import { describe, expect, it } from 'vitest';

import { createTaskInitCommand } from '../../src/cli/task-init-command.js';

describe('task init command', () => {
  it('creates a task without accepting a caller-provided task ID', async () => {
    let received: unknown;
    let output = '';
    const command = createTaskInitCommand({
      initializer: { async init(input: { projectRoot: string; source: string; skillProfile: string }) { received = input; return { id: 'task-20260813-120000-000', status: 'active', skillProfile: { name: 'standard-web-feature', version: '1.0.0' }, nodes: {} }; } } as never,
      defaultSkillProfile: async () => 'standard-web-feature@2.0.0',
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'init', '--project', '/repo', '--source', '/repo/requirements.md', '--skill-profile', 'standard-web-feature@1.0.0']);

    expect(received).toEqual({ projectRoot: '/repo', source: '/repo/requirements.md', skillProfile: 'standard-web-feature@1.0.0' });
    expect(output).toContain('task-20260813-120000-000');
  });

  it('rejects a manually supplied task ID', async () => {
    const command = createTaskInitCommand({
      initializer: { async init() { throw new Error('不应调用初始化器'); } } as never,
      defaultSkillProfile: async () => 'standard-web-feature@2.0.0',
      stdout: { write() { return true; } } as unknown as NodeJS.WriteStream,
    });
    command.configureOutput({ writeErr() {} });
    command.exitOverride();

    await expect(command.parseAsync(['node', 'init', 'manual-id', '--project', '/repo', '--source', '/repo/requirements.md', '--skill-profile', 'standard-web-feature@1.0.0']))
      .rejects.toMatchObject({ code: 'commander.excessArguments' });
  });

  it('uses the local default profile when the caller omits the override', async () => {
    let received: unknown;
    const command = createTaskInitCommand({
      initializer: { async init(input: unknown) { received = input; return { id: 'task-20260813-120000-000', status: 'active', skillProfile: { name: 'standard-web-feature', version: '2.0.0' }, nodes: {} }; } } as never,
      defaultSkillProfile: async () => 'standard-web-feature@2.0.0',
      stdout: { write() { return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'init', '--project', '/repo', '--source', '/repo/requirements.md']);

    expect(received).toEqual({ projectRoot: '/repo', source: '/repo/requirements.md', skillProfile: 'standard-web-feature@2.0.0' });
  });
});
