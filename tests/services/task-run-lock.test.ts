import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';

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

  it('reclaims a legacy empty lock after its grace period', async () => {
    const runtimeRoot = await createTempDirectory('aiw-task-lock-');
    directories.push(runtimeRoot);
    const taskId = 'refund-123';
    const lockDirectory = join(runtimeRoot, '.locks', createHash('sha256').update(taskId, 'utf8').digest('hex'));
    await mkdir(lockDirectory, { recursive: true });
    await utimes(lockDirectory, new Date(0), new Date(0));

    const lock = new FileTaskRunLock(runtimeRoot, { legacyLockGraceMs: 1, now: () => 2 });

    await expect(lock.acquire({ taskId })).resolves.toBeDefined();
  });
});
