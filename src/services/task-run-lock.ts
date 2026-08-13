import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface TaskRunLease {
  release(): Promise<void>;
}

export interface TaskRunLock {
  acquire(input: { taskId: string }): Promise<TaskRunLease | undefined>;
}

export class FileTaskRunLock implements TaskRunLock {
  constructor(private readonly runtimeRoot: string) {}

  async acquire(input: { taskId: string }): Promise<TaskRunLease | undefined> {
    const lockDirectory = join(this.runtimeRoot, '.locks', lockKey(input.taskId));
    await mkdir(join(this.runtimeRoot, '.locks'), { recursive: true });
    try {
      await mkdir(lockDirectory);
    } catch (error) {
      if (isAlreadyExists(error)) {
        return undefined;
      }
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
}

function lockKey(taskId: string): string {
  return createHash('sha256').update(taskId, 'utf8').digest('hex');
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
