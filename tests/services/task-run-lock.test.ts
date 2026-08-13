import { afterEach, describe, expect, it } from 'vitest';

import { FileTaskRunLock } from '../../src/services/task-run-lock.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('FileTaskRunLock', () => {
  const directories: string[] = [];

  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('refuses a concurrent lease for the same task and releases it afterwards', async () => {
    const runtimeRoot = await createTempDirectory('aiw-task-lock-');
    directories.push(runtimeRoot);
    const lock = new FileTaskRunLock(runtimeRoot);

    const first = await lock.acquire({ taskId: 'refund-123' });
    const second = await lock.acquire({ taskId: 'refund-123' });

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    await first?.release();
    await expect(lock.acquire({ taskId: 'refund-123' })).resolves.toBeDefined();
  });
});
