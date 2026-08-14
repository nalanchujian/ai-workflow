import { describe, expect, it } from 'vitest';

import { createRunHistoryCommand } from '../../src/cli/run-history-command.js';

describe('run history command', () => {
  it('forwards show and safe prune options to the runtime history service', async () => {
    const received: unknown[] = [];
    let output = '';
    const command = createRunHistoryCommand({
      history: {
        async show(input: unknown) { received.push(['show', input]); return { schemaVersion: 'aiw.run-history/v1', taskId: 'refund-123', runId: 'run-1', status: 'succeeded', logs: [], context: {} }; },
        async prune(input: unknown) { received.push(['prune', input]); return { schemaVersion: 'aiw.run-prune/v1', apply: true, olderThanDays: 30, candidates: [], deleted: [] }; },
      } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'run', 'show', 'refund-123', 'run-1', '--project', '/repo']);
    await command.parseAsync(['node', 'run', 'prune', '--older-than', '30d', '--apply']);

    expect(received).toEqual([
      ['show', { projectRoot: '/repo', taskId: 'refund-123', runId: 'run-1' }],
      ['prune', { olderThanDays: 30, apply: true }],
    ]);
    expect(output).toContain('运行记录：已完成');
    expect(output).toContain('运行 ID：run-1');
    expect(output).not.toContain('"schemaVersion"');
  });
});
