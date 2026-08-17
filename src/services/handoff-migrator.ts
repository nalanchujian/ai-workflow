import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { stringify } from 'yaml';

import type { RunRequest, RunResult } from '../domain/run.js';
import { registeredDecisionFactPaths, TaskSchema, type Phase, type Task } from '../domain/task.js';
import { handoffPath, validateHandoff } from '../domain/handoff.js';
import type { WorkingTreeStatus } from '../ports/repository-status.js';
import { TaskFactGuard } from './task-fact-guard.js';
import { TaskStore } from './task-store.js';

type MigrationAdapter = Pick<{ run(input: RunRequest): Promise<RunResult> }, 'run'>;

export class HandoffMigrationError extends Error {
  constructor(readonly code: 'WORKTREE_DIRTY' | 'MIGRATION_FAILED' | 'CHANGE_SCOPE_VIOLATION', message: string) {
    super(message);
    this.name = 'HandoffMigrationError';
  }
}

export interface HandoffMigrationResult {
  taskId: string;
  migrationId: string;
  migratedNodeIds: string[];
  skippedNodeIds: string[];
  auditPaths: string[];
}

/** Backfills auditable handoffs for tasks created before handoff.yaml became mandatory. */
export class HandoffMigrator {
  constructor(private readonly deps: {
    taskStore: TaskStore;
    taskFactGuard: TaskFactGuard;
    changeInspector: Pick<WorkingTreeStatus, 'changedPaths'>;
    adapter: MigrationAdapter;
    runtimeRoot: string;
    runIdFactory?: () => string;
  }) {}

  async migrate(input: { taskId: string }): Promise<HandoffMigrationResult> {
    const task = await this.deps.taskStore.load(input.taskId);
    const before = await this.deps.changeInspector.changedPaths({ projectRoot: this.deps.taskStore.projectDirectory() });
    if (before.length > 0) {
      throw new HandoffMigrationError('WORKTREE_DIRTY', `业务仓库存在未提交变更，无法迁移交接包：${before.join(', ')}`);
    }
    const pending = await nodesMissingHandoff(task, this.deps.taskStore);
    const ordered = topologicalOrder(task, pending);
    await this.deps.taskFactGuard.assertCommitted({
      task,
      projectRoot: this.deps.taskStore.projectDirectory(),
      paths: migrationInputPaths(task, ordered),
    });
    const migrationId = this.deps.runIdFactory?.() ?? `migration-${randomUUID()}`;
    const migratedNodeIds: string[] = [];
    const auditPaths: string[] = [];

    for (const nodeId of ordered) {
      const node = task.nodes[nodeId]!;
      const path = handoffPath(nodeId, node.revision);
      if (node.phase === 'intake') {
        const content = nativeIntakeHandoff(task, nodeId);
        validateHandoff(content, handoffExpectation(task, nodeId));
        await this.deps.taskStore.createFact(task.id, path, content);
      } else {
        const result = await this.deps.adapter.run(await migrationRequest(task, nodeId, path, join(this.deps.runtimeRoot, task.id, migrationId), this.deps.taskStore));
        if (result.status !== 'succeeded') {
          throw new HandoffMigrationError('MIGRATION_FAILED', `节点 ${nodeId} 的交接包迁移失败：${result.error?.message ?? result.status}`);
        }
        const content = await readTaskFact(this.deps.taskStore, task.id, path);
        try {
          validateHandoff(content, handoffExpectation(task, nodeId));
        } catch (error) {
          throw new HandoffMigrationError('MIGRATION_FAILED', `节点 ${nodeId} 的交接包无效：${error instanceof Error ? error.message : '未知错误'}`);
        }
      }
      const auditPath = `migrations/handoffs/${migrationId}/${nodeId}.json`;
      await this.deps.taskStore.createFact(task.id, auditPath, JSON.stringify({
        schemaVersion: 'aiw.handoff-migration/v1', taskId: task.id, migrationId, nodeId,
        nodeRevision: node.revision, handoffPath: path, migratedAt: new Date().toISOString(),
        handoffSha256: createHash('sha256').update(await readTaskFact(this.deps.taskStore, task.id, path), 'utf8').digest('hex'),
      }, null, 2) + '\n');
      task.events.push({ type: 'migrate_handoff', nodeId, at: new Date().toISOString(), evidencePath: auditPath, note: `已补齐 ${path}` });
      await this.deps.taskStore.update(TaskSchema.parse(task));
      migratedNodeIds.push(nodeId);
      auditPaths.push(auditPath);
    }

    const after = await this.deps.changeInspector.changedPaths({ projectRoot: this.deps.taskStore.projectDirectory() });
    const unexpected = after.filter((path) => !allowedMigrationPath(path, task, migrationId, this.deps.taskStore.projectDirectory(), this.deps.taskStore.taskDirectory(task.id)));
    if (unexpected.length > 0) {
      throw new HandoffMigrationError('CHANGE_SCOPE_VIOLATION', `迁移过程中检测到业务代码或未声明文件变更：${unexpected.join(', ')}`);
    }
    return { taskId: task.id, migrationId, migratedNodeIds, skippedNodeIds: completedNodeIds(task).filter((nodeId) => !pending.has(nodeId)), auditPaths };
  }
}

async function nodesMissingHandoff(task: Task, taskStore: TaskStore): Promise<Set<string>> {
  const results = await Promise.all(completedNodeIds(task).map(async (nodeId) => {
    const node = task.nodes[nodeId]!;
    try {
      const content = await readFile(join(taskStore.taskDirectory(task.id), handoffPath(nodeId, node.revision)), 'utf8');
      validateHandoff(content, handoffExpectation(task, nodeId));
      return undefined;
    } catch {
      return nodeId;
    }
  }));
  return new Set(results.filter((nodeId): nodeId is string => nodeId !== undefined));
}

function completedNodeIds(task: Task): string[] {
  return Object.entries(task.nodes)
    .filter(([, node]) => node.status === 'completed')
    .map(([nodeId]) => nodeId);
}

function topologicalOrder(task: Task, candidates: Set<string>): string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    for (const dependency of task.nodes[nodeId]?.dependsOn ?? []) {
      if (candidates.has(dependency)) visit(dependency);
    }
    if (candidates.has(nodeId)) ordered.push(nodeId);
  };
  for (const nodeId of [...candidates].sort((left, right) => left.localeCompare(right))) visit(nodeId);
  return ordered;
}

function migrationInputPaths(task: Task, nodeIds: string[]): string[] {
  return [...new Set([
    'task.yaml',
    ...Object.values(task.sources).flatMap((source) => [source.snapshotPath, source.metaPath]),
    ...nodeIds.flatMap((nodeId) => migrationContextPaths(task, nodeId)),
  ])];
}

async function migrationRequest(task: Task, nodeId: string, outputPath: string, runDirectory: string, taskStore: TaskStore): Promise<RunRequest> {
  const node = task.nodes[nodeId]!;
  const sourcePaths = new Set(Object.values(task.sources).map((source) => source.snapshotPath));
  const files = await Promise.all(migrationContextPaths(task, nodeId).map(async (path) => ({
    role: sourcePaths.has(path) ? 'source' as const : 'artifact' as const,
    path,
    content: await readTaskFact(taskStore, task.id, path),
  })));
  return {
    schemaVersion: 'aiw.run/v1',
    runId: `handoff-${nodeId}-${randomUUID()}`,
    task: { id: task.id, nodeId, phase: node.phase as Exclude<Phase, 'intake'>, nodeRevision: node.revision, projectRoot: taskStore.projectDirectory() },
    instruction: `这是历史交接包迁移。仅根据已注入的历史任务事实生成 ${outputPath}；不要修改业务代码、旧产物或任务状态，不得补充未经证据支持的结论。`,
    contextManifestPath: join(taskStore.taskDirectory(task.id), 'task.yaml'),
    runDirectory,
    mode: 'execute',
    artifacts: [outputPath],
    allowedChangePaths: [],
    context: {
      skill: { name: 'handoff-migration', version: '1.0.0', content: '将历史产物压缩为可追溯的结构化交接包；每项结论必须引用实际证据路径。' },
      methodSources: [],
      files,
    },
  };
}

function migrationContextPaths(task: Task, nodeId: string): string[] {
  const node = task.nodes[nodeId]!;
  const directDependencies = node.dependsOn.flatMap((dependency) => task.nodes[dependency]?.outputs ?? []);
  return [...new Set([
    ...(node.phase === 'clarify' ? Object.values(task.sources).map((source) => source.snapshotPath) : []),
    ...directDependencies,
    ...node.outputs,
  ])];
}

function handoffExpectation(task: Task, nodeId: string): Parameters<typeof validateHandoff>[1] {
  const node = task.nodes[nodeId]!;
  return {
    taskId: task.id, nodeId, phase: node.phase, revision: node.revision,
    evidencePaths: [...new Set([
      ...Object.values(task.sources).flatMap((source) => [source.snapshotPath, source.metaPath]),
      ...registeredDecisionFactPaths(task),
      ...dependencyClosure(task, nodeId).flatMap((dependency) => task.nodes[dependency]?.outputs ?? []),
      ...node.outputs,
    ])],
  };
}

function nativeIntakeHandoff(task: Task, nodeId: string): string {
  const node = task.nodes[nodeId]!;
  const evidencePath = Object.values(task.sources)[0]?.snapshotPath ?? node.outputs[0];
  return stringify({
    schemaVersion: 'aiw.handoff/v1', taskId: task.id, nodeId, phase: node.phase, revision: node.revision,
    summary: '已根据已固化的历史来源快照补齐资料接入交接包。',
    facts: [{ id: 'FACT-01', statement: '历史需求来源与快照已作为共享任务事实保留。', evidence: [{ path: evidencePath }] }],
    decisions: [], acceptance: [], changes: [], verification: [], openRisks: [],
  });
}

function dependencyClosure(task: Task, nodeId: string): string[] {
  const found = new Set<string>();
  const visit = (candidate: string): void => {
    if (found.has(candidate)) return;
    found.add(candidate);
    for (const dependency of task.nodes[candidate]?.dependsOn ?? []) visit(dependency);
  };
  for (const dependency of task.nodes[nodeId]?.dependsOn ?? []) visit(dependency);
  return [...found];
}

async function readTaskFact(taskStore: TaskStore, taskId: string, path: string): Promise<string> {
  return readFile(join(taskStore.taskDirectory(taskId), path), 'utf8');
}

function allowedMigrationPath(path: string, task: Task, migrationId: string, projectRoot: string, taskDirectory: string): boolean {
  const taskRoot = relative(projectRoot, taskDirectory).replaceAll('\\', '/');
  return path === `${taskRoot}/task.yaml`
    || path.startsWith(`${taskRoot}/handoffs/`)
    || path.startsWith(`${taskRoot}/migrations/handoffs/${migrationId}/`);
}
