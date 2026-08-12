import { describe, expect, it } from 'vitest';

import { createTaskSourceRefreshCommand } from '../../src/cli/task-source-refresh-command.js';

describe('task source refresh command', () => {
  it('prints the refresh result for the requested task source', async () => {
    let output = '';
    const command = createTaskSourceRefreshCommand({
      refresher: { async refresh() { return { changed: true, revision: 2, task: {} }; } } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'refresh', 'refund-123', 'requirements']);

    expect(output).toContain('"changed": true');
    expect(output).toContain('"revision": 2');
  });
});
