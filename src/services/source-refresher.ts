import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { Task } from '../domain/task.js';
import { restartDependentsForSourceChange } from './task-state-machine.js';
import { SourceIntake } from './source-intake.js';
import { TaskStore } from './task-store.js';
import type { TaskRunLock } from './task-run-lock.js';
import { withTaskMutationLock } from './task-mutation-lock.js';

export class SourceRefreshError extends Error {
  constructor(message: string) { super(message); this.name = 'SourceRefreshError'; }
}

export interface RefreshResult { changed: boolean; revision: number; task: Task }

export class SourceRefresher {
  constructor(private readonly deps: { intake: SourceIntake; taskStore: TaskStore; taskLock?: TaskRunLock }) {}

  async refresh(input: { taskId: string; sourceId: string }): Promise<RefreshResult> {
    return withTaskMutationLock(this.deps.taskLock, input.taskId, async () => {
      const task = await this.deps.taskStore.load(input.taskId);
      const current = task.sources[input.sourceId];
      if (current === undefined) throw new SourceRefreshError(`来源不存在：${input.sourceId}`);
      const snapshot = await this.deps.intake.snapshot({
        sourceId: input.sourceId,
        value: sourceValue(this.deps.taskStore.projectDirectory(), current.kind, current.origin),
        ...(current.section === undefined ? {} : { section: current.section }),
        revision: current.revision + 1,
      });
      const previous = await readFile(join(this.deps.taskStore.taskDirectory(task.id), current.snapshotPath), 'utf8');
      if (snapshot.markdown === previous) return { changed: false, revision: current.revision, task };

      const reference = await this.deps.intake.writeSnapshot({ snapshot, taskDirectory: this.deps.taskStore.taskDirectory(task.id) });
      const recognitionNode = task.nodes['api-document-recognition'];
      const upstreamNodeId = input.sourceId.startsWith('api-document-') && recognitionNode !== undefined
        ? 'api-document-recognition'
        : 'intake';
      const next = restartDependentsForSourceChange(task, upstreamNodeId, `来源 ${input.sourceId} 已更新`);
      next.sources[input.sourceId] = reference;
      if (upstreamNodeId === 'api-document-recognition') {
        next.nodes[upstreamNodeId]!.outputs = Object.entries(next.sources)
          .filter(([sourceId]) => sourceId.startsWith('api-document-'))
          .flatMap(([, source]) => [source.snapshotPath, source.metaPath]);
      } else {
        next.nodes.intake!.outputs = [reference.snapshotPath, reference.metaPath];
      }
      return { changed: true, revision: reference.revision, task: await this.deps.taskStore.update(next) };
    });
  }
}

function sourceValue(projectRoot: string, kind: Task['sources'][string]['kind'], origin: string): string {
  if (kind !== 'local-file' || isAbsolute(origin) || origin === 'local:redacted') return origin;
  return join(projectRoot, origin);
}
