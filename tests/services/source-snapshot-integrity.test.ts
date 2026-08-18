import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SourceSnapshotIntegrity } from '../../src/services/source-snapshot-integrity.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

describe('SourceSnapshotIntegrity', () => {
  it('accepts a snapshot whose bytes, metadata and task index have the same hash', async () => {
    const { store, task } = await fixture();

    await expect(new SourceSnapshotIntegrity(store).assert(task)).resolves.toBeUndefined();
  });

  it('rejects a snapshot whose body changed after task creation', async () => {
    const { store, task, directory } = await fixture();
    await writeFile(join(directory, 'sources', 'requirements', 'r1', 'snapshot.md'), '# 被手动改写的需求\n', 'utf8');

    await expect(new SourceSnapshotIntegrity(store).assert(task))
      .rejects.toThrow('快照内容哈希与 task.yaml 不一致');
  });

  it('rejects metadata whose hash no longer matches the task index', async () => {
    const { store, task, directory } = await fixture();
    await writeFile(join(directory, 'sources', 'requirements', 'r1', 'meta.json'), JSON.stringify({
      sourceId: 'requirements',
      kind: 'connected-document',
      origin: 'https://example.test/requirements',
      revision: 1,
      fetchedAt: '2026-08-18T00:00:00.000Z',
      contentSha256: 'f'.repeat(64),
      extractor: 'test/fixture',
    }) + '\n', 'utf8');

    await expect(new SourceSnapshotIntegrity(store).assert(task))
      .rejects.toThrow('meta.json 内容哈希与 task.yaml 不一致');
  });

  it('rejects metadata whose source identity no longer matches the task index', async () => {
    const { store, task, directory } = await fixture();
    const contentSha256 = task.sources.requirements!.contentSha256;
    await writeFile(join(directory, 'sources', 'requirements', 'r1', 'meta.json'), JSON.stringify({
      sourceId: 'requirements',
      kind: 'connected-document',
      origin: 'https://example.test/another-requirements',
      revision: 1,
      fetchedAt: '2026-08-18T00:00:00.000Z',
      contentSha256,
      extractor: 'test/fixture',
    }) + '\n', 'utf8');

    await expect(new SourceSnapshotIntegrity(store).assert(task))
      .rejects.toThrow('meta.json 身份信息与 task.yaml 不一致');
  });
});

async function fixture() {
  const directory = await createTempDirectory('aiw-source-integrity-');
  directories.push(directory);
  const store = new TaskStore(directory);
  const task = createSevenPhaseTask();
  task.repository = directory;
  const content = '# 原始需求\n';
  const contentSha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  task.sources.requirements = {
    kind: 'connected-document',
    origin: 'https://example.test/requirements',
    revision: 1,
    snapshotPath: 'sources/requirements/r1/snapshot.md',
    metaPath: 'sources/requirements/r1/meta.json',
    contentSha256,
  };
  await store.create(task);
  await mkdir(join(store.taskDirectory(task.id), 'sources', 'requirements', 'r1'), { recursive: true });
  await writeFile(join(store.taskDirectory(task.id), 'sources', 'requirements', 'r1', 'snapshot.md'), content, 'utf8');
  await writeFile(join(store.taskDirectory(task.id), 'sources', 'requirements', 'r1', 'meta.json'), JSON.stringify({
    sourceId: 'requirements',
    kind: 'connected-document',
    origin: 'https://example.test/requirements',
    revision: 1,
    fetchedAt: '2026-08-18T00:00:00.000Z',
    contentSha256,
    extractor: 'test/fixture',
  }) + '\n', 'utf8');
  return { directory: store.taskDirectory(task.id), store, task };
}
