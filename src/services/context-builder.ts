import { readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  ContextManifestSchema,
  type ContextBudgetCategory,
  type ContextFile,
  type ContextManifest,
} from '../domain/context.js';
import type { Task } from '../domain/task.js';

export class ContextBuilderError extends Error {
  constructor(
    readonly code: 'CONTEXT_BUDGET_EXCEEDED' | 'CONTEXT_INVALID',
    message: string,
    readonly paths: string[] = [],
  ) {
    super(message);
    this.name = 'ContextBuilderError';
  }
}

export interface ContextBudgetInput {
  category?: ContextBudgetCategory;
  label: string;
  content: string;
}

export class ContextBuilder {
  constructor(private readonly deps: {
    taskDirectory: (task: Task) => string;
    projectRoot: (task: Task) => string;
    maxTokens?: number | (() => Promise<number>);
  }) {}

  async build(input: {
    task: Task;
    nodeId: string;
    includes: string[];
    budgetInputs?: ContextBudgetInput[];
    enforceBudget?: boolean;
  }): Promise<ContextManifest> {
    const node = input.task.nodes[input.nodeId];
    if (node === undefined || node.phase === 'intake' || node.skill === undefined) {
      throw new ContextBuilderError('CONTEXT_INVALID', '当前节点不能创建上下文');
    }
    const taskDirectory = this.deps.taskDirectory(input.task);
    const projectRoot = this.deps.projectRoot(input.task);
    const files = await Promise.all(defaultFiles(input.task, input.nodeId).map((file) => this.load(file, taskDirectory)));
    for (const path of input.includes) files.push(await this.loadAdditional(path, projectRoot));
    const deduplicated = [...new Map(files.map((file) => [`${file.role}:${file.absolutePath}`, file])).values()];
    const imagePaths = defaultImages();
    await Promise.all(imagePaths.map((path) => resolveInside(taskDirectory, path)));
    const maxTokens = typeof this.deps.maxTokens === 'function'
      ? await this.deps.maxTokens()
      : this.deps.maxTokens ?? DEFAULT_CONTEXT_TOKEN_BUDGET;
    const budgetInputs: ContextBudgetInput[] = [
      ...deduplicated.map((file) => ({ category: categoryFor(file.role), label: file.path, content: file.content })),
      ...(input.budgetInputs ?? []),
    ];
    const manifest = ContextManifestSchema.parse({
      schemaVersion: 'aiw.context/v2',
      taskId: input.task.id,
      nodeId: input.nodeId,
      skillProfile: input.task.skillProfile,
      files: deduplicated.map(({ role, path }) => ({ role, path })),
      images: imagePaths.map((path) => ({ path })),
      skill: node.skill,
      budget: budgetFromInputs(maxTokens, budgetInputs),
    });
    if (input.enforceBudget !== false) this.assertWithinBudget(manifest);
    return manifest;
  }

  finalizePromptBudget(input: { manifest: ContextManifest; prompt: string }): ContextManifest {
    const known = input.manifest.budget.breakdown.filter((entry) => entry.category !== 'runtime-overhead');
    const knownTokens = known.reduce((total, entry) => total + entry.estimatedTokens, 0);
    const promptTokens = estimateTokens(input.prompt);
    const manifest = ContextManifestSchema.parse({
      ...input.manifest,
      budget: {
        maxTokens: input.manifest.budget.maxTokens,
        estimatedTokens: promptTokens,
        breakdown: [...known, {
          category: 'runtime-overhead', label: '运行约束与提示词结构',
          estimatedTokens: Math.max(0, promptTokens - knownTokens),
        }],
      },
    });
    this.assertWithinBudget(manifest);
    return manifest;
  }

  private async load(file: ContextFile, root: string): Promise<LoadedContextFile> {
    const absolutePath = await resolveInside(root, file.path);
    return { ...file, absolutePath, content: await readFile(absolutePath, 'utf8') };
  }

  private async loadAdditional(path: string, projectRoot: string): Promise<LoadedContextFile> {
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new ContextBuilderError('CONTEXT_INVALID', '附加文件必须是项目内相对路径');
    }
    return this.load({ role: 'additional', path }, projectRoot);
  }

  private assertWithinBudget(manifest: ContextManifest): void {
    if (manifest.budget.estimatedTokens <= manifest.budget.maxTokens) return;
    const breakdown = [...manifest.budget.breakdown]
      .filter((entry) => entry.estimatedTokens > 0)
      .sort((left, right) => right.estimatedTokens - left.estimatedTokens);
    throw new ContextBuilderError(
      'CONTEXT_BUDGET_EXCEEDED',
      `上下文超过预算：约 ${manifest.budget.estimatedTokens} / ${manifest.budget.maxTokens} tokens。\n构成：\n${breakdown.map((entry) => `- ${entry.label}（约 ${entry.estimatedTokens} tokens）`).join('\n')}\n建议：精简直接上游产物后重试。`,
      breakdown.map((entry) => entry.label),
    );
  }
}

interface LoadedContextFile extends ContextFile {
  absolutePath: string;
  content: string;
}

function defaultFiles(task: Task, nodeId: string): ContextFile[] {
  const node = task.nodes[nodeId];
  if (node === undefined) throw new ContextBuilderError('CONTEXT_INVALID', `未知节点：${nodeId}`);
  if (node.phase === 'design') {
    return Object.values(task.sources).map((source) => ({ role: 'source' as const, path: source.snapshotPath }));
  }
  if (node.phase === 'clarify') {
    return [
      ...Object.values(task.sources).map((source) => ({ role: 'source' as const, path: source.snapshotPath })),
      ...designArtifacts(task),
    ];
  }
  if (node.phase === 'solution') {
    return [
      { role: 'artifact', path: 'artifacts/clarify/fact-register.yaml' },
      { role: 'artifact', path: 'artifacts/clarify/decision-register.yaml' },
      ...designArtifacts(task),
    ];
  }
  if (node.phase === 'plan') {
    return [{ role: 'artifact', path: 'artifacts/solution/solution.md' }, ...designArtifacts(task)];
  }
  if (node.contextPath === undefined) {
    throw new ContextBuilderError('CONTEXT_INVALID', `开发节点缺少独立上下文：${nodeId}`);
  }
  return [{ role: 'artifact', path: node.contextPath }];
}

function designArtifacts(task: Task): ContextFile[] {
  return task.designInput === undefined ? [] : [
    { role: 'artifact', path: 'artifacts/design/design-catalog.yaml' },
    { role: 'artifact', path: 'artifacts/design/design-rules.yaml' },
  ];
}

function defaultImages(): string[] { return []; }

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

function estimateTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, 'utf8') / 4);
}

function budgetFromInputs(maxTokens: number, inputs: ContextBudgetInput[]) {
  const breakdown = inputs.map((entry) => ({
    category: entry.category ?? 'task-fact', label: entry.label, estimatedTokens: estimateTokens(entry.content),
  }));
  return { maxTokens, estimatedTokens: breakdown.reduce((sum, entry) => sum + entry.estimatedTokens, 0), breakdown };
}

function categoryFor(role: ContextFile['role']): ContextBudgetCategory {
  return role === 'source' ? 'source' : role === 'generated' ? 'generated' : role === 'additional' ? 'additional' : 'task-fact';
}
