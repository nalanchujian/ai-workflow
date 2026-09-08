import { describe, expect, it } from 'vitest';

import { createTaskInitCommand } from '../../src/cli/task-init-command.js';

describe('task init command', () => {
  it('accepts only project, one requirement URL, profile and force-new', async () => {
    let received: unknown;
    let output = '';
    const command = createTaskInitCommand({
      initializer: { async init(input: unknown) { received = input; return { id: 'task-1', skillProfile: { name: 'standard-web-feature' }, status: 'active' }; } } as never,
      defaultSkillProfile: async () => 'standard-web-feature',
      progress: silentProgress(),
      stdout: writable((value) => { output += value; }),
    });

    await command.parseAsync(['node', 'init', '--project', '/repo', '--source', 'https://docs.example.test/requirements', '--force-new'], { from: 'node' });

    expect(received).toEqual({ projectRoot: '/repo', source: 'https://docs.example.test/requirements', skillProfile: 'standard-web-feature', forceNew: true });
    expect(output).toContain('aiw task run task-1 requirement-analysis');
  });

  it('rejects removed section, YApi and design-image options', async () => {
    const command = createTaskInitCommand({
      initializer: { async init() { throw new Error('not reached'); } } as never,
      defaultSkillProfile: async () => 'standard-web-feature',
      progress: silentProgress(),
      stdout: writable(() => undefined),
    });
    command.exitOverride();
    for (const option of ['--section', '--api-doc-id', '--design-image']) {
      await expect(command.parseAsync(['node', 'init', '--project', '/repo', '--source', 'https://docs.example.test/requirements', option, 'value'], { from: 'node' })).rejects.toThrow();
    }
  });
});

function writable(write: (value: string) => void): NodeJS.WriteStream { return { write(value: string) { write(value); return true; } } as unknown as NodeJS.WriteStream; }
function silentProgress() { return { start() { return { succeed() {}, fail() {} }; } } as never; }
