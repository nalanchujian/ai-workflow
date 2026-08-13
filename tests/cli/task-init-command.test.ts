import { describe, expect, it } from 'vitest';

import { createTaskInitCommand } from '../../src/cli/task-init-command.js';

describe('task init command', () => {
  it('passes the explicit task initialization inputs to the initializer', async () => {
    let received: unknown;
    let output = '';
    const command = createTaskInitCommand({
      initializer: { async init(input: { id: string; projectRoot: string; source: string; skillProfile: string }) { received = input; return { id: input.id, status: 'active', skillProfile: { name: 'standard-web-feature', version: '1.0.0' }, nodes: {} }; } } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'init', 'refund-123', '--project', '/repo', '--source', '/repo/requirements.md', '--skill-profile', 'standard-web-feature@1.0.0']);

    expect(received).toEqual({ id: 'refund-123', projectRoot: '/repo', source: '/repo/requirements.md', skillProfile: 'standard-web-feature@1.0.0' });
    expect(output).toContain('refund-123');
  });
});
