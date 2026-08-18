import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import {
  ContextManifestSchema,
  type ContextBudgetCategory,
  type ContextFile,
  type ContextManifest,
} from '../domain/context.js';
import { completedArtifactPath, handoffPath } from '../domain/handoff.js';
import { registeredDecisionFactPaths, type Task } from '../domain/task.js';

const DEFAULT_TOKEN_BUDGET = 12_000;

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

export class ContextBuilder {
  constructor(private readonly deps: {
    taskDirectory: (task: Task) => string;
    projectRoot: (task: Task) => string;
    maxTokens?: number;
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
    const files = await this.defaultFiles(input.task, input.nodeId, node.phase, taskDirectory);
    for (const include of input.includes) {
      files.push(await this.additionalFile(include, projectRoot));
    }
    const deduplicated = [...new Map(files.map((file) => [file.absolutePath, file])).values()];
    const contextFiles = deduplicated.map((file) => ({
      role: file.role,
      path: file.path,
      sha256: file.sha256,
      evidenceEligible: file.evidenceEligible,
      ...(file.sourceId === undefined ? {} : { sourceId: file.sourceId }),
      ...(file.sourceRevision === undefined ? {} : { sourceRevision: file.sourceRevision }),
    }));
    const budgetInputs: ContextBudgetInput[] = [
      ...deduplicated.map((file) => ({ category: budgetCategoryForFile(file), label: file.path, content: file.content })),
      ...(input.budgetInputs ?? []),
    ];
    const maxTokens = this.deps.maxTokens ?? DEFAULT_TOKEN_BUDGET;
    const manifest = ContextManifestSchema.parse({
      schemaVersion: 'aiw.context/v1',
      taskId: input.task.id,
      nodeId: input.nodeId,
      nodeRevision: node.revision,
      skillProfile: input.task.skillProfile,
      files: contextFiles,
      skill: node.skill,
      budget: budgetFromInputs(maxTokens, budgetInputs),
    });
    if (input.enforceBudget !== false) this.assertWithinBudget(manifest);
    return manifest;
  }

  finalizePromptBudget(input: { manifest: ContextManifest; prompt: string }): ContextManifest {
    const withoutRuntimeOverhead = input.manifest.budget.breakdown.filter((entry) => entry.category !== 'runtime-overhead');
    const knownTokens = withoutRuntimeOverhead.reduce((total, entry) => total + entry.estimatedTokens, 0);
    const promptTokens = estimateTokens(input.prompt);
    const runtimeOverhead = Math.max(0, promptTokens - knownTokens);
    const manifest = ContextManifestSchema.parse({
      ...input.manifest,
      budget: {
        maxTokens: input.manifest.budget.maxTokens,
        estimatedTokens: promptTokens,
        breakdown: [
          ...withoutRuntimeOverhead,
          { category: 'runtime-overhead', label: '运行约束与提示词结构', estimatedTokens: runtimeOverhead },
        ],
      },
    });
    this.assertWithinBudget(manifest);
    return manifest;
  }

  private assertWithinBudget(manifest: ContextManifest): void {
    if (manifest.budget.estimatedTokens <= manifest.budget.maxTokens) return;
    const breakdown = [...manifest.budget.breakdown]
      .filter((entry) => entry.estimatedTokens > 0)
      .sort((left, right) => right.estimatedTokens - left.estimatedTokens);
    const labels = breakdown.map((entry) => entry.label);
    const details = breakdown.map((entry) => `- ${budgetCategoryLabel(entry.category)}：${entry.label}（约 ${entry.estimatedTokens} tokens）`).join('\n');
    throw new ContextBuilderError(
      'CONTEXT_BUDGET_EXCEEDED',
      `上下文超过预算：约 ${manifest.budget.estimatedTokens} / ${manifest.budget.maxTokens} tokens。\n构成：\n${details}\n建议：${budgetSuggestion(breakdown[0]?.category)}`,
      labels,
    );
  }

  private async defaultFiles(task: Task, nodeId: string, phase: Exclude<Task['nodes'][string]['phase'], 'intake'>, taskDirectory: string): Promise<ContextFileWithContent[]> {
    const paths = defaultPaths(task, nodeId, phase);
    const files = await Promise.all(paths.map(async (input) => {
      const absolutePath = await resolveInside(taskDirectory, input.path);
      const content = await readFile(absolutePath, 'utf8');
      return {
        role: input.role,
        path: input.path,
        evidenceEligible: input.evidenceEligible ?? true,
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
        ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision }),
        sha256: sha256(content),
        absolutePath,
        content,
      };
    }));
    if (phase === 'solution' || phase === 'plan') {
      const clarify = task.nodes.clarify;
      const decisionRegister = clarify === undefined || clarify.revision === 0
        ? undefined
        : await this.optionalTaskFact(taskDirectory, completedArtifactPath('clarify', clarify, 'artifacts/decision-register.yaml'));
      if (decisionRegister !== undefined) files.push(decisionRegister);
      files.push(...await Promise.all(registeredDecisionFactPaths(task).map((path) => this.requiredTaskFact(taskDirectory, path))));
    }
    return files;
  }

  private async optionalTaskFact(taskDirectory: string, path: string): Promise<ContextFileWithContent | undefined> {
    try {
      const absolutePath = await resolveInside(taskDirectory, path);
      const content = await readFile(absolutePath, 'utf8');
      return { role: 'artifact', path, sha256: sha256(content), evidenceEligible: true, absolutePath, content };
    } catch (error) {
      if (error instanceof ContextBuilderError && error.message === `上下文文件不存在：${path}`) return undefined;
      throw error;
    }
  }

  private async requiredTaskFact(taskDirectory: string, path: string): Promise<ContextFileWithContent> {
    const absolutePath = await resolveInside(taskDirectory, path);
    const content = await readFile(absolutePath, 'utf8');
    return { role: 'artifact', path, sha256: sha256(content), evidenceEligible: true, absolutePath, content };
  }

  private async additionalFile(path: string, projectRoot: string): Promise<ContextFileWithContent> {
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new ContextBuilderError('CONTEXT_INVALID', '附加文件必须是项目内相对路径');
    }
    const absolutePath = await resolveInside(projectRoot, path);
    const content = await readFile(absolutePath, 'utf8');
    return { role: 'additional', path, sha256: sha256(content), evidenceEligible: false, absolutePath, content };
  }
}

interface ContextFileWithContent extends ContextFile {
  absolutePath: string;
  content: string;
}

type ContextFileInput = Omit<ContextFile, 'sha256' | 'evidenceEligible'> & { evidenceEligible?: boolean };

export interface ContextBudgetInput {
  category?: ContextBudgetCategory;
  label: string;
  content: string;
}

function defaultPaths(task: Task, nodeId: string, phase: Exclude<Task['nodes'][string]['phase'], 'intake'>): ContextFileInput[] {
  const node = task.nodes[nodeId];
  const currentContextPath = effectiveContextPath(task, nodeId, node);
  const contextPath = currentContextPath === undefined ? [] : [{ role: 'artifact' as const, path: currentContextPath }];
  if (phase !== 'clarify') {
    return [...handoffInputs(task, nodeId), { role: 'task', path: 'task.yaml' }, ...contextPath];
  }
  const defaults: Record<Exclude<Task['nodes'][string]['phase'], 'intake'>, string[]> = {
    clarify: ['task.md'],
    solution: [],
    plan: [],
    implement: [],
    verify: [],
    test: [],
  };
  const files: ContextFileInput[] = [
    ...defaults[phase].map((path) => ({ role: path === 'task.md' ? 'task' as const : 'artifact' as const, path })),
    { role: 'task', path: 'task.yaml' },
  ];
  if (phase === 'clarify') {
    for (const [sourceId, source] of Object.entries(task.sources)) {
      files.push({ role: 'source', path: source.snapshotPath, sourceId, sourceRevision: source.revision });
    }
  }
  return [...files, ...contextPath];
}

function effectiveContextPath(task: Task, nodeId: string, node: Task['nodes'][string] | undefined): string | undefined {
  if (node?.contextPath === undefined) return undefined;
  if (nodeId === 'implement' && node.contextPath === 'artifacts/implementation-context.md') {
    const plan = task.nodes.plan;
    return plan === undefined || plan.revision === 0
      ? node.contextPath
      : completedArtifactPath('plan', plan, node.contextPath);
  }
  return node.contextPath;
}

function handoffInputs(task: Task, nodeId: string): ContextFileInput[] {
  const node = task.nodes[nodeId];
  if (node === undefined) return [];
  return [...new Set(node.dependsOn)]
    .sort((left, right) => left.localeCompare(right))
    .map((dependency) => {
      const upstream = task.nodes[dependency];
      if (upstream === undefined) {
        throw new ContextBuilderError('CONTEXT_INVALID', `节点依赖不存在：${dependency}`);
      }
      return { role: 'handoff' as const, path: handoffPath(dependency, upstream.revision) };
    });
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

function budgetFromInputs(maxTokens: number, inputs: ContextBudgetInput[]) {
  const breakdown = inputs.map((entry) => ({
    category: entry.category ?? 'task-fact',
    label: entry.label,
    estimatedTokens: estimateTokens(entry.content),
  }));
  return {
    maxTokens,
    estimatedTokens: breakdown.reduce((total, entry) => total + entry.estimatedTokens, 0),
    breakdown,
  };
}

function budgetCategoryForFile(file: ContextFileWithContent): ContextBudgetCategory {
  return ({
    task: 'task-fact',
    source: 'source',
    artifact: 'task-fact',
    handoff: 'handoff',
    additional: 'additional',
  } as const)[file.role];
}

function budgetCategoryLabel(category: ContextBudgetCategory): string {
  return ({
    'task-fact': '任务事实',
    source: '需求来源',
    handoff: '结构化交接',
    additional: '附加文件',
    'node-instruction': '节点指令',
    skill: '阶段技能',
    'method-source': '通用方法论',
    'runtime-overhead': '运行约束与提示词结构',
  } as const)[category];
}

function budgetSuggestion(category: ContextBudgetCategory | undefined): string {
  return ({
    source: '缩小需求章节范围，或先在澄清节点形成更聚焦的结构化交接。',
    handoff: '退回上游节点精简交接包，或将实施计划拆分为更小的工作单元。',
    'task-fact': '检查任务事实是否包含重复或不再需要的内容；不要删除已批准原文。',
    additional: '移除不必要的 --include 文件，必要时只提供相关章节。',
    skill: '精简当前阶段技能的重复说明，或将通用规则下沉到固定运行约束。',
    'method-source': '精简当前阶段引用的方法论，只保留本节点必需的方法。',
    'runtime-overhead': '当前阶段固定约束过大；应精简重复的产物契约，而非压缩任务事实。',
    'node-instruction': '将节点目标收敛为可执行的单一工作单元。',
  } as Record<ContextBudgetCategory, string>)[category ?? 'task-fact'];
}
