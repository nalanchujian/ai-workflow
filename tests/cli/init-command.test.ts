import { describe, expect, it } from 'vitest';

import { createInitCommand } from '../../src/cli/init-command.js';

describe('init command', () => {
  it('initializes the local configuration template', async () => {
    let output = '';
    const command = createInitCommand({
      initializer: { async init() { return { schemaVersion: 'aiw.init/v1', status: 'created', configPath: '/home/j/.aiw/config.yaml' }; } } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'init']);

    expect(output).toContain('"status": "created"');
    expect(output).toContain('/home/j/.aiw/config.yaml');
  });
});
