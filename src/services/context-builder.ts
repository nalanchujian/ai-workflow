import { createHash } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { ContextManifestSchema, type ContextFile, type ContextManifest } from '../domain/context.js';
import type { Task } from '../domain/task.js';

const DEFAULT_TOKEN_BUDGET = 12_000;

export class ContextBuilderError extends Error {
  constructor(readonly code: 'CONTEXT_BUDGET_EXCEEDED' | 'CONTEXT_INVALID', message: string, readonly paths: string[] = []) {
    super(message);
    this.name = 'ContextBuilderError';
  }
}

export class ContextBuilder {
  constructor(private readonly deps: {
    taskDirectory: (task: Task) => string;
    projectRoot: (task: Task) => string;
    maxTokens?: number;
  }) {}

  async build(input: { task: Task; nodeId: string; includes: string[]; budgetInputs?: ContextBudgetInput[] }): Promise<ContextManifest> {
    const node = input.task.nodes[input.nodeId];
    if (node === undefined || node.phase === 'intake' || node.skill === undefined) {
      throw new ContextBuilderError('CONTEXT_INVALID', '当前节点不能创建上下文');
    }
    const taskDirectory = this.deps.taskDirectory(input.task);
    const projectRoot = this.deps.projectRoot(input.task);
    const files = await this.defaultFiles(input.task, input.nodeId, node.phase, taskDirectory);
    for (const include of input.includes) {
      files.push(await this.additionalFile(include, projectRoot));
    }
    const deduplicated = [...new Map(files.map((file) => [file.absolutePath, file])).values()];
    const contextFiles = deduplicated.map((file) => ({
      role: file.role,
      path: file.path,
      sha256: file.sha256,
      ...(file.sourceId === undefined ? {} : { sourceId: file.sourceId }),
      ...(file.sourceRevision === undefined ? {} : { sourceRevision: file.sourceRevision }),
    }));
    const budgetInputs = [
      ...deduplicated.map((file) => ({ label: file.path, content: file.content })),
      ...(input.budgetInputs ?? []),
    ];
    const estimatedTokens = budgetInputs.reduce((total, entry) => total + estimateTokens(entry.content), 0);
    const maxTokens = this.deps.maxTokens ?? DEFAULT_TOKEN_BUDGET;
    if (estimatedTokens > maxTokens) {
      throw new ContextBuilderError('CONTEXT_BUDGET_EXCEEDED', '上下文超过预算，未截断任何内容', budgetInputs.map((entry) => entry.label));
    }
    return ContextManifestSchema.parse({
      schemaVersion: 'aiw.context/v1',
      taskId: input.task.id,
      nodeId: input.nodeId,
      nodeRevision: node.revision,
      skillProfile: input.task.skillProfile,
      files: contextFiles,
      skill: node.skill,
      budget: { maxTokens, estimatedTokens },
    });
  }

  private async defaultFiles(task: Task, nodeId: string, phase: Exclude<Task['nodes'][string]['phase'], 'intake'>, taskDirectory: string): Promise<ContextFileWithContent[]> {
    const paths = defaultPaths(task, nodeId, phase);
    const files = await Promise.all(paths.map(async (input) => {
      const absolutePath = await resolveInside(taskDirectory, input.path);
      const content = await readFile(absolutePath, 'utf8');
      return {
        role: input.role,
        path: input.path,
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
        ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision }),
        sha256: sha256(content),
        absolutePath,
        content,
      };
    }));
    const revisionPath = `revisions/${nodeId}/r${task.nodes[nodeId]?.revision + 1}.md`;
    const absoluteRevisionPath = join(taskDirectory, revisionPath);
    try {
      await access(absoluteRevisionPath);
      const resolvedRevisionPath = await resolveInside(taskDirectory, revisionPath);
      const content = await readFile(resolvedRevisionPath, 'utf8');
      files.push({ role: 'revision-request', path: revisionPath, sha256: sha256(content), absolutePath: resolvedRevisionPath, content });
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
    return files;
  }

  private async additionalFile(path: string, projectRoot: string): Promise<ContextFileWithContent> {
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new ContextBuilderError('CONTEXT_INVALID', '附加文件必须是项目内相对路径');
    }
    const absolutePath = await resolveInside(projectRoot, path);
    const content = await readFile(absolutePath, 'utf8');
    return { role: 'additional', path, sha256: sha256(content), absolutePath, content };
  }
}

interface ContextFileWithContent extends ContextFile {
  absolutePath: string;
  content: string;
}

interface ContextBudgetInput {
  label: string;
  content: string;
}

function defaultPaths(task: Task, nodeId: string, phase: Exclude<Task['nodes'][string]['phase'], 'intake'>): Array<Omit<ContextFile, 'sha256'>> {
  const defaults: Record<Exclude<Task['nodes'][string]['phase'], 'intake'>, string[]> = {
    clarify: ['task.md'],
    solution: ['task.md', 'artifacts/brief.md', 'artifacts/questions.md', 'artifacts/acceptance.md'],
    plan: ['artifacts/brief.md', 'artifacts/questions.md', 'artifacts/acceptance.md', 'artifacts/solution.md'],
    implement: ['artifacts/acceptance.md', task.nodes[nodeId]?.contextPath ?? 'artifacts/implementation-context.md'],
    verify: ['artifacts/brief.md', 'artifacts/acceptance.md', 'artifacts/solution.md', 'artifacts/implementation-plan.md', 'artifacts/implementation.md'],
    test: ['artifacts/brief.md', 'artifacts/acceptance.md', 'artifacts/solution.md', 'artifacts/implementation-plan.md', 'artifacts/implementation.md', 'artifacts/verification.md'],
  };
  const files: Array<Omit<ContextFile, 'sha256'>> = defaults[phase].map((path) => ({ role: path === 'task.md' ? 'task' : 'artifact', path }));
  if (phase === 'clarify') {
    for (const [sourceId, source] of Object.entries(task.sources)) {
      files.push({ role: 'source', path: source.snapshotPath, sourceId, sourceRevision: source.revision });
    }
  }
  return files;
}

async function resolveInside(root: string, path: string): Promise<string> {
  const resolvedRoot = await realpath(root).catch(() => resolve(root));
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(join(resolvedRoot, path));
  } catch {
    throw new ContextBuilderError('CONTEXT_INVALID', `上下文文件不存在：${path}`);
  }
  if (relative(resolvedRoot, resolvedPath).startsWith('..')) {
    throw new ContextBuilderError('CONTEXT_INVALID', `上下文文件越出允许范围：${path}`);
  }
  return resolvedPath;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function estimateTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, 'utf8') / 4);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
