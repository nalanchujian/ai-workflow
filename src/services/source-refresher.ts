import type { Task } from '../domain/task.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { stringify } from 'yaml';
import { handoffPath, validateHandoff } from '../domain/handoff.js';
import { restartDependentsForSourceChange } from './task-state-machine.js';
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
      sourceId: input.sourceId,
      value: sourceValue(this.deps.taskStore.projectDirectory(), current.kind, current.origin),
      ...(current.section === undefined ? {} : { section: current.section }),
      revision: current.revision + 1,
    });
    if (snapshot.contentSha256 === current.contentSha256) {
      return { changed: false, revision: current.revision, task };
    }
    const reference = await this.deps.intake.writeSnapshot({ snapshot, taskDirectory: this.deps.taskStore.taskDirectory(task.id) });
    const next = restartDependentsForSourceChange(task, 'intake', `source ${input.sourceId} changed`);
    next.sources[input.sourceId] = reference;
    next.nodes.intake.revision = reference.revision;
    next.nodes.intake.outputs = [reference.snapshotPath, reference.metaPath];
    const intakeHandoffPath = handoffPath('intake', next.nodes.intake.revision);
    const intakeHandoff = stringify({
      schemaVersion: 'aiw.handoff/v1',
      taskId: next.id,
      nodeId: 'intake',
      phase: 'intake',
      revision: next.nodes.intake.revision,
      summary: '已固化更新后的需求来源快照与提取边界。',
      facts: [{
        id: 'FACT-01',
        statement: `需求来源已更新至 revision ${reference.revision}。`,
        evidence: [{ path: reference.snapshotPath }],
      }],
      decisions: [],
      acceptance: [],
      changes: [],
      verification: [],
      openRisks: [],
    });
    validateHandoff(intakeHandoff, {
      taskId: next.id,
      nodeId: 'intake',
      phase: 'intake',
      revision: next.nodes.intake.revision,
      evidencePaths: [reference.snapshotPath, reference.metaPath],
    });
    const taskDirectory = this.deps.taskStore.taskDirectory(task.id);
    await mkdir(dirname(join(taskDirectory, intakeHandoffPath)), { recursive: true });
    await writeFile(join(taskDirectory, intakeHandoffPath), intakeHandoff, 'utf8');
    await this.deps.taskStore.update(next);
    return { changed: true, revision: reference.revision, task: next };
  }
}

function sourceValue(projectRoot: string, kind: Task['sources'][string]['kind'], origin: string): string {
  if (kind !== 'local-file' || isAbsolute(origin) || origin === 'local:redacted') {
    return origin;
  }
  return join(projectRoot, origin);
}
