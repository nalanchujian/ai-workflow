import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_LEGACY_LOCK_GRACE_MS = 5 * 60 * 1_000;

export interface TaskRunLease {
  release(): Promise<void>;
}

export interface TaskRunLock {
  acquire(input: { taskId: string }): Promise<TaskRunLease | undefined>;
}

export class FileTaskRunLock implements TaskRunLock {
  private readonly deps: { now: () => number; processId: () => number; isProcessAlive: (pid: number) => boolean; legacyLockGraceMs: number };

  constructor(
    private readonly runtimeRoot: string,
    deps: Partial<{ now: () => number; processId: () => number; isProcessAlive: (pid: number) => boolean; legacyLockGraceMs: number }> = {},
  ) {
    this.deps = {
      now: () => Date.now(),
      processId: () => process.pid,
      isProcessAlive,
      legacyLockGraceMs: DEFAULT_LEGACY_LOCK_GRACE_MS,
      ...deps,
    };
  }

  async acquire(input: { taskId: string }): Promise<TaskRunLease | undefined> {
    const lockDirectory = join(this.runtimeRoot, '.locks', lockKey(input.taskId));
    await mkdir(join(this.runtimeRoot, '.locks'), { recursive: true });
    try {
      await mkdir(lockDirectory);
    } catch (error) {
      if (isAlreadyExists(error)) {
        if (await this.isStale(lockDirectory)) {
          await rm(lockDirectory, { recursive: true, force: true });
          return this.acquire(input);
        }
        return undefined;
      }
      throw error;
    }

    try {
      await writeFile(join(lockDirectory, 'owner.json'), JSON.stringify({ pid: this.deps.processId(), startedAt: new Date(this.deps.now()).toISOString() }) + '\n', 'utf8');
    } catch (error) {
      await rm(lockDirectory, { recursive: true, force: true });
      throw error;
    }

    let released = false;
    return {
      async release() {
        if (released) {
          return;
        }
        released = true;
        await rm(lockDirectory, { recursive: true, force: true });
      },
    };
  }

  private async isStale(lockDirectory: string): Promise<boolean> {
    try {
      const owner = JSON.parse(await readFile(join(lockDirectory, 'owner.json'), 'utf8')) as { pid?: unknown };
      if (typeof owner.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0) {
        return !this.deps.isProcessAlive(owner.pid);
      }
    } catch {
      // Earlier AIW versions created an empty lock directory. Apply a short grace period below.
    }
    const info = await stat(lockDirectory);
    return this.deps.now() - info.mtimeMs >= this.deps.legacyLockGraceMs;
  }
}

function lockKey(taskId: string): string {
  return createHash('sha256').update(taskId, 'utf8').digest('hex');
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH');
  }
}
