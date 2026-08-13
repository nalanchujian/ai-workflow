import type { Task } from '../domain/task.js';
import { isAbsolute, join } from 'node:path';
import { invalidateDependents } from './task-state-machine.js';
import { SourceIntake } from './source-intake.js';
import { TaskStore } from './task-store.js';

export class SourceRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceRefreshError';
  }
}

export interface RefreshResult {
  changed: boolean;
  revision: number;
  task: Task;
}

export class SourceRefresher {
  constructor(private readonly deps: { intake: SourceIntake; taskStore: TaskStore }) {}

  async refresh(input: { taskId: string; sourceId: string }): Promise<RefreshResult> {
    const task = await this.deps.taskStore.load(input.taskId);
    const current = task.sources[input.sourceId];
    if (current === undefined) {
      throw new SourceRefreshError(`来源不存在：${input.sourceId}`);
    }
    const snapshot = await this.deps.intake.snapshot({
      kind: current.kind,
      sourceId: input.sourceId,
      value: sourceValue(task, current.kind, current.origin),
      ...(current.section === undefined ? {} : { section: current.section }),
      revision: current.revision + 1,
    });
    if (snapshot.contentSha256 === current.contentSha256) {
      return { changed: false, revision: current.revision, task };
    }
    const reference = await this.deps.intake.writeSnapshot({ snapshot, taskDirectory: this.deps.taskStore.taskDirectory(task.id) });
    const next = invalidateDependents(task, 'intake', `source ${input.sourceId} changed`);
    next.sources[input.sourceId] = reference;
    next.nodes.intake.revision += 1;
    next.nodes.intake.outputs = [reference.snapshotPath, reference.metaPath];
    await this.deps.taskStore.update(next);
    return { changed: true, revision: reference.revision, task: next };
  }
}

function sourceValue(task: Task, kind: Task['sources'][string]['kind'], origin: string): string {
  if (kind !== 'local-file' || isAbsolute(origin) || origin === 'local:redacted') {
    return origin;
  }
  return join(task.repository, origin);
}
