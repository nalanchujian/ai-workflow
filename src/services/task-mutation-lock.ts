import type { TaskRunLock } from './task-run-lock.js';

export class TaskMutationBusyError extends Error {
  constructor() {
    super('当前任务正在被其他命令修改，请等待当前操作结束后重试');
    this.name = 'TaskMutationBusyError';
  }
}

/** Runs a complete task-fact transaction under the shared per-task lock. */
export async function withTaskMutationLock<T>(
  lock: TaskRunLock | undefined,
  taskId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (lock === undefined) return operation();
  const lease = await lock.acquire({ taskId });
  if (lease === undefined) throw new TaskMutationBusyError();
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}
