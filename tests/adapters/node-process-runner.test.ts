import { describe, expect, it } from 'vitest';

import { NodeProcessRunner } from '../../src/adapters/node-process-runner.js';

describe('NodeProcessRunner', () => {
  it('passes stdin to a child process and collects its output', async () => {
    const runner = new NodeProcessRunner();

    const result = await runner.run({
      command: process.execPath,
      args: ['-e', 'process.stdin.on("data", (chunk) => process.stdout.write(chunk.toString().toUpperCase()))'],
      cwd: process.cwd(),
      stdin: 'aiw',
    });

    expect(result).toMatchObject({ exitCode: 0, signal: null, stdout: 'AIW' });
  });
});
