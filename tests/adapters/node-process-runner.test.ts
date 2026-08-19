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

  it('terminates only the active child when its abort signal is raised', async () => {
    const runner = new NodeProcessRunner();
    const controller = new AbortController();
    const pending = runner.run({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 10_000)'],
      cwd: process.cwd(),
      stdin: '',
      timeoutMs: 20_000,
      signal: controller.signal,
    });

    controller.abort('terminal closed');

    await expect(pending).resolves.toMatchObject({ exitCode: null, signal: 'SIGTERM', timedOut: false });
  });

  it('returns the child exit result when stdin closes before the input is written', async () => {
    const runner = new NodeProcessRunner();

    const result = await runner.run({
      command: process.execPath,
      args: ['-e', 'process.exit(2)'],
      cwd: process.cwd(),
      stdin: 'x'.repeat(8 * 1024 * 1024),
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ exitCode: 2, signal: null, timedOut: false });
  });
});
