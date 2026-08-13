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
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ exitCode: 0, signal: null, stdout: 'AIW' });
  });

  it('terminates a process that exceeds its timeout', async () => {
    const runner = new NodeProcessRunner();

    const result = await runner.run({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 100)'],
      cwd: process.cwd(),
      stdin: '',
      timeoutMs: 10,
    });

    expect(result.timedOut).toBe(true);
  });
});
