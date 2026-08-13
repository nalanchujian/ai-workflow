import { access, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { ContextManifestSchema } from '../domain/context.js';
import { RunHistorySchema, RunPruneResultSchema, type RunHistory, type RunPruneResult } from '../domain/run-history.js';
import { RunResultSchema } from '../domain/run.js';

const runSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class RunHistoryService {
  constructor(private readonly deps: { runtimeRoot: string; now?: () => Date }) {}

  async show(input: { projectRoot: string; taskId: string; runId: string }): Promise<RunHistory> {
    assertSegment(input.taskId, '任务 ID');
    assertSegment(input.runId, '运行 ID');
    const sharedDirectory = join(input.projectRoot, '.aiw', 'tasks', input.taskId, 'runs', input.runId);
    const [result, manifest] = await Promise.all([
      readJson(join(sharedDirectory, 'result.json'), RunResultSchema),
      readJson(join(sharedDirectory, 'context-manifest.json'), ContextManifestSchema),
    ]);
    if (result.runId !== input.runId || manifest.taskId !== input.taskId) {
      throw new Error('运行记录与请求的任务不一致');
    }
    const localDirectory = await this.runDirectory(input.taskId, input.runId);
    const logs = await Promise.all([
      log('context', join(localDirectory, 'context.md')),
      log('stdout', join(localDirectory, 'stdout.log')),
      log('stderr', join(localDirectory, 'stderr.log')),
      log('last-message', join(localDirectory, 'last-message.md')),
      log('request', join(localDirectory, 'request.json')),
    ]);
    return RunHistorySchema.parse({
      schemaVersion: 'aiw.run-history/v1',
      taskId: input.taskId,
      runId: input.runId,
      status: result.status,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      artifacts: result.artifacts,
      ...(result.error === undefined ? {} : { error: result.error }),
      logs,
      context: {
        manifestPath: join(sharedDirectory, 'context-manifest.json'),
        nodeId: manifest.nodeId,
        nodeRevision: manifest.nodeRevision,
        fileCount: manifest.files.length,
        roles: [...new Set(manifest.files.map((file) => file.role))].sort(),
        estimatedTokens: manifest.budget.estimatedTokens,
        maxTokens: manifest.budget.maxTokens,
      },
    });
  }

  async prune(input: { olderThanDays: number; apply: boolean }): Promise<RunPruneResult> {
    if (!Number.isInteger(input.olderThanDays) || input.olderThanDays <= 0) {
      throw new Error('保留期必须是正整数天数');
    }
    const candidates = await this.expiredDirectories(input.olderThanDays);
    const deleted = [] as typeof candidates;
    if (input.apply) {
      for (const candidate of candidates) {
        await rm(candidate.path, { force: false, recursive: true });
        deleted.push(candidate);
      }
    }
    return RunPruneResultSchema.parse({
      schemaVersion: 'aiw.run-prune/v1',
      apply: input.apply,
      olderThanDays: input.olderThanDays,
      candidates,
      deleted,
    });
  }

  private async expiredDirectories(olderThanDays: number): Promise<Array<{ taskId: string; runId: string; path: string; modifiedAt: string }>> {
    const runtimeRoot = await realpath(this.deps.runtimeRoot).catch(() => undefined);
    if (runtimeRoot === undefined) {
      return [];
    }
    const cutoff = (this.deps.now?.() ?? new Date()).getTime() - olderThanDays * 24 * 60 * 60 * 1_000;
    const candidates: Array<{ taskId: string; runId: string; path: string; modifiedAt: string }> = [];
    for (const taskEntry of await readdir(runtimeRoot, { withFileTypes: true })) {
      if (!taskEntry.isDirectory() || taskEntry.isSymbolicLink() || !runSegmentPattern.test(taskEntry.name)) {
        continue;
      }
      const taskDirectory = join(runtimeRoot, taskEntry.name);
      for (const runEntry of await readdir(taskDirectory, { withFileTypes: true })) {
        if (!runEntry.isDirectory() || runEntry.isSymbolicLink() || !runSegmentPattern.test(runEntry.name)) {
          continue;
        }
        const path = await this.runDirectory(taskEntry.name, runEntry.name, runtimeRoot);
        const details = await stat(path);
        if (details.mtimeMs < cutoff) {
          candidates.push({ taskId: taskEntry.name, runId: runEntry.name, path, modifiedAt: details.mtime.toISOString() });
        }
      }
    }
    return candidates.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async runDirectory(taskId: string, runId: string, resolvedRoot?: string): Promise<string> {
    const root = resolvedRoot ?? resolve(this.deps.runtimeRoot);
    const directory = resolve(root, taskId, runId);
    if (relative(root, directory).startsWith('..')) {
      throw new Error('本机运行目录越出允许范围');
    }
    return directory;
  }
}

async function readJson<T>(path: string, schema: { parse(value: unknown): T }): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, 'utf8')));
}

async function log(kind: 'context' | 'stdout' | 'stderr' | 'last-message' | 'request', path: string): Promise<{ kind: typeof kind; path: string; available: boolean }> {
  try {
    await access(path);
    return { kind, path, available: true };
  } catch {
    return { kind, path, available: false };
  }
}

function assertSegment(value: string, label: string): void {
  if (!runSegmentPattern.test(value)) {
    throw new Error(`${label}格式无效`);
  }
}
