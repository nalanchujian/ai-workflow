import type { Task } from '../domain/task.js';
import type { RepositoryStatus } from '../ports/repository-status.js';

export class TaskFactGuardError extends Error {
  constructor(readonly code: 'TASK_FACTS_UNCOMMITTED' | 'ACTOR_UNAVAILABLE', readonly paths: string[], message: string) {
    super(message);
    this.name = 'TaskFactGuardError';
  }
}

export class TaskFactGuard {
  constructor(private readonly deps: { repositoryStatus: RepositoryStatus }) {}

  async assertCommitted(input: { task: Task; paths: string[]; projectRoot?: string }): Promise<void> {
    const uncommitted = await this.uncommittedPaths(input);
    if (uncommitted.length > 0) {
      throw new TaskFactGuardError('TASK_FACTS_UNCOMMITTED', uncommitted, `任务事实尚未提交：${uncommitted.join(', ')}`);
    }
  }

  async uncommittedPaths(input: { task: Task; paths: string[]; projectRoot?: string }): Promise<string[]> {
    const paths = [...new Set(input.paths)];
    return this.deps.repositoryStatus.uncommittedPaths({ projectRoot: input.projectRoot ?? input.task.repository, paths });
  }

  async actor(actor?: string): Promise<string> {
    if (actor !== undefined && actor.trim().length > 0) {
      return actor;
    }
    const name = await this.deps.repositoryStatus.authorName?.();
    if (name === undefined || name.trim().length === 0) {
      throw new TaskFactGuardError('ACTOR_UNAVAILABLE', [], '无法确定审批人身份');
    }
    return name;
  }
}
