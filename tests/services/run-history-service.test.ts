import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RunHistoryService } from '../../src/services/run-history-service.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('RunHistoryService', () => {
  const directories: string[] = [];

  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('shows the shared result, local log paths, and a context summary without returning context content', async () => {
    const fixture = await createRunFixture(directories, 'run-1');

    const result = await new RunHistoryService({ runtimeRoot: fixture.runtimeRoot }).show({ projectRoot: fixture.projectRoot, taskId: 'refund-123', runId: 'run-1' });

    expect(result).toMatchObject({
      schemaVersion: 'aiw.run-history/v1',
      taskId: 'refund-123',
      runId: 'run-1',
      status: 'succeeded',
      context: {
        nodeId: 'clarify', fileCount: 2, roles: ['source', 'task'], estimatedTokens: 42, maxTokens: 12_000,
        breakdown: expect.arrayContaining([{ category: 'source', label: 'sources/requirements/r1/snapshot.md', estimatedTokens: 30 }]),
      },
    });
    expect(result.logs).toContainEqual({ kind: 'stdout', path: join(fixture.runtimeRoot, 'refund-123', 'run-1', 'stdout.log'), available: true });
    expect(JSON.stringify(result)).not.toContain('这是完整上下文正文');
  });

  it('previews expired run directories and deletes only those candidates after explicit apply', async () => {
    const fixture = await createRunFixture(directories, 'old-run');
    const freshDirectory = join(fixture.runtimeRoot, 'refund-123', 'fresh-run');
    await mkdir(freshDirectory, { recursive: true });
    await writeFile(join(freshDirectory, 'keep.txt'), 'keep', 'utf8');
    const now = new Date('2026-08-13T00:00:00.000Z');
    const old = new Date('2026-07-01T00:00:00.000Z');
    await utimes(join(fixture.runtimeRoot, 'refund-123', 'old-run'), old, old);
    await utimes(freshDirectory, now, now);
    const service = new RunHistoryService({ runtimeRoot: fixture.runtimeRoot, now: () => now });

    const preview = await service.prune({ olderThanDays: 30, apply: false });

    expect(preview).toMatchObject({ apply: false, olderThanDays: 30, candidates: [{ taskId: 'refund-123', runId: 'old-run' }], deleted: [] });
    await expect(readFile(join(fixture.runtimeRoot, 'refund-123', 'old-run', 'context.md'), 'utf8')).resolves.toContain('完整上下文');

    const applied = await service.prune({ olderThanDays: 30, apply: true });

    expect(applied).toMatchObject({ apply: true, deleted: [{ taskId: 'refund-123', runId: 'old-run' }] });
    await expect(readFile(join(fixture.runtimeRoot, 'refund-123', 'old-run', 'context.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(fixture.runtimeRoot, 'refund-123', 'fresh-run', 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });
});

async function createRunFixture(directories: string[], runId: string) {
  const projectRoot = await createTempDirectory('aiw-run-history-project-');
  const runtimeRoot = await createTempDirectory('aiw-run-history-runtime-');
  directories.push(projectRoot, runtimeRoot);
  const sharedDirectory = join(projectRoot, '.aiw', 'tasks', 'refund-123', 'runs', runId);
  const localDirectory = join(runtimeRoot, 'refund-123', runId);
  await mkdir(sharedDirectory, { recursive: true });
  await mkdir(localDirectory, { recursive: true });
  const hash = 'a'.repeat(64);
  await writeFile(join(sharedDirectory, 'result.json'), JSON.stringify({
    schemaVersion: 'aiw.run-result/v1', runId, status: 'succeeded', runDirectory: localDirectory,
    startedAt: '2026-08-01T00:00:00.000Z', finishedAt: '2026-08-01T00:01:00.000Z', artifacts: [],
  }), 'utf8');
  await writeFile(join(sharedDirectory, 'context-manifest.json'), JSON.stringify({
    schemaVersion: 'aiw.context/v1', taskId: 'refund-123', nodeId: 'clarify',
    skillProfile: { name: 'standard-web-feature', version: '1.0.0', registrySource: { url: 'https://example.test/skills.git', revision: 'abc123' }, sha256: hash },
    files: [{ role: 'task', path: 'task.md', sha256: hash }, { role: 'source', path: 'sources/requirements/r1/snapshot.md', sha256: hash, sourceId: 'requirements', sourceRevision: 1 }],
    skill: { name: 'requirements-clarification', version: '1.0.0', registrySource: { url: 'https://example.test/skills.git', revision: 'abc123' }, sha256: hash, methodSources: [] },
    budget: {
      maxTokens: 12_000,
      estimatedTokens: 42,
      breakdown: [
        { category: 'task-fact', label: 'task.md', estimatedTokens: 12 },
        { category: 'source', label: 'sources/requirements/r1/snapshot.md', estimatedTokens: 30 },
      ],
    },
  }), 'utf8');
  await writeFile(join(localDirectory, 'context.md'), '这是完整上下文正文', 'utf8');
  await writeFile(join(localDirectory, 'stdout.log'), 'stdout', 'utf8');
  await writeFile(join(localDirectory, 'stderr.log'), 'stderr', 'utf8');
  return { projectRoot, runtimeRoot };
}
