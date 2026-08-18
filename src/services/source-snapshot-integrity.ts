import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';

import { SourceKindSchema, type SourceReference, type Task } from '../domain/task.js';
import { TaskStore } from './task-store.js';

const sha256Pattern = /^[a-f0-9]{64}$/;

const SourceSnapshotMetaSchema = z.object({
  sourceId: z.string().min(1),
  kind: SourceKindSchema,
  origin: z.string().min(1),
  externalId: z.string().min(1).optional(),
  resolvedExternalId: z.string().min(1).optional(),
  section: z.string().min(1).optional(),
  sectionStartBlockId: z.string().min(1).optional(),
  sectionEndBlockId: z.string().min(1).optional(),
  revision: z.number().int().positive(),
  fetchedAt: z.string().datetime(),
  contentSha256: z.string().regex(sha256Pattern),
  extractor: z.string().min(1),
}).strict();

export class SourceSnapshotIntegrityError extends Error {
  constructor(
    message: string,
    readonly sourceId?: string,
  ) {
    super(message);
    this.name = 'SourceSnapshotIntegrityError';
  }
}

/**
 * Confirms that the task index, snapshot metadata and snapshot bytes describe
 * the same immutable source revision before an Agent can consume it.
 */
export class SourceSnapshotIntegrity {
  constructor(private readonly taskStore: TaskStore) {}

  async assert(task: Task): Promise<void> {
    for (const [sourceId, source] of Object.entries(task.sources).sort(([left], [right]) => left.localeCompare(right))) {
      await this.assertOne(task, sourceId, source);
    }
  }

  private async assertOne(task: Task, sourceId: string, source: SourceReference): Promise<void> {
    const taskDirectory = this.taskStore.taskDirectory(task.id);
    let snapshotPath: string;
    let metaPath: string;
    try {
      [snapshotPath, metaPath] = await Promise.all([
        resolveInside(taskDirectory, source.snapshotPath),
        resolveInside(taskDirectory, source.metaPath),
      ]);
    } catch (error) {
      throw sourceError(sourceId, error);
    }
    let snapshot: Buffer;
    let metadata: z.infer<typeof SourceSnapshotMetaSchema>;
    try {
      [snapshot, metadata] = await Promise.all([
        readFile(snapshotPath),
        readFile(metaPath, 'utf8').then((content) => SourceSnapshotMetaSchema.parse(JSON.parse(content))),
      ]);
    } catch {
      throw new SourceSnapshotIntegrityError(`来源「${sourceId}」的快照或元数据无法读取`, sourceId);
    }
    const contentSha256 = createHash('sha256').update(snapshot).digest('hex');
    if (contentSha256 !== source.contentSha256) {
      throw new SourceSnapshotIntegrityError(`来源「${sourceId}」的快照内容哈希与 task.yaml 不一致`, sourceId);
    }
    if (metadata.contentSha256 !== source.contentSha256) {
      throw new SourceSnapshotIntegrityError(`来源「${sourceId}」的 meta.json 内容哈希与 task.yaml 不一致`, sourceId);
    }
    if (!sameSourceIdentity(sourceId, source, metadata)) {
      throw new SourceSnapshotIntegrityError(`来源「${sourceId}」的 meta.json 身份信息与 task.yaml 不一致`, sourceId);
    }
  }
}

function sourceError(sourceId: string, error: unknown): SourceSnapshotIntegrityError {
  if (error instanceof SourceSnapshotIntegrityError) {
    return new SourceSnapshotIntegrityError(error.message.replace('来源快照文件', `来源「${sourceId}」的快照文件`), sourceId);
  }
  return new SourceSnapshotIntegrityError(`来源「${sourceId}」的快照或元数据无法读取`, sourceId);
}

function sameSourceIdentity(
  sourceId: string,
  source: SourceReference,
  metadata: z.infer<typeof SourceSnapshotMetaSchema>,
): boolean {
  return metadata.sourceId === sourceId
    && metadata.kind === source.kind
    && metadata.origin === source.origin
    && metadata.revision === source.revision
    && metadata.externalId === source.externalId
    && metadata.resolvedExternalId === source.resolvedExternalId
    && metadata.section === source.section
    && metadata.sectionStartBlockId === source.sectionStartBlockId
    && metadata.sectionEndBlockId === source.sectionEndBlockId;
}

async function resolveInside(root: string, path: string): Promise<string> {
  const resolvedRoot = await realpath(root).catch(() => resolve(root));
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(join(resolvedRoot, path));
  } catch {
    throw new SourceSnapshotIntegrityError(`来源快照文件不存在：${path}`);
  }
  if (relative(resolvedRoot, resolvedPath).startsWith('..')) {
    throw new SourceSnapshotIntegrityError(`来源快照文件越出任务目录：${path}`);
  }
  return resolvedPath;
}
