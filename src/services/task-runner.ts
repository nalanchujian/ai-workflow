import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { CodexAdapter } from '../adapters/codex-adapter.js';
import { RunResultSchema, type RunRequest, type RunResult } from '../domain/run.js';
import type { ContextManifest } from '../domain/context.js';
import type { OutputRecord, SkillLock, Task } from '../domain/task.js';
import type { MethodSourceResolverPort } from '../ports/method-source-resolver.js';
import type { WorkingTreeStatus } from '../ports/repository-status.js';
import { ContextBuilder } from './context-builder.js';
import { SkillRegistry } from './skill-registry.js';
import { TaskFactGuard } from './task-fact-guard.js';
import { FileTaskRunLock, type TaskRunLock } from './task-run-lock.js';
import { transitionNode } from './task-state-machine.js';
import { TaskStore } from './task-store.js';

export class TaskRunnerError extends Error {
  constructor(readonly code: 'NODE_NOT_RUNNABLE' | 'TASK_BUSY' | 'SKILL_LOCK_INVALID' | 'ARTIFACT_MISSING' | 'ARTIFACT_INVALID' | 'WORKTREE_DIRTY' | 'CHANGE_SCOPE_MISSING' | 'RUN_RECOVERED', message: string) {
    super(message);
    this.name = 'TaskRunnerError';
  }
}

export class TaskRunner {
  private readonly runLock: TaskRunLock;

  constructor(private readonly deps: {
    taskStore: TaskStore;
    skillRegistry: SkillRegistry;
    methodSourceResolver: MethodSourceResolverPort;
    contextBuilder: ContextBuilder;
    taskFactGuard: TaskFactGuard;
    changeInspector: WorkingTreeStatus;
    adapter: CodexAdapter;
    runtimeRoot: string;
    runIdFactory?: () => string;
    runLock?: TaskRunLock;
  }) {
    this.runLock = deps.runLock ?? new FileTaskRunLock(deps.runtimeRoot);
  }

  async run(input: { taskId: string; nodeId: string; dryRun: boolean; includes: string[] }): Promise<RunResult> {
    const lease = await this.runLock.acquire({ taskId: input.taskId });
    if (lease === undefined) {
      throw new TaskRunnerError('TASK_BUSY', '当前任务已有节点正在运行');
    }
    try {
      return await this.runLocked(input);
    } finally {
      await lease.release();
    }
  }

  private async runLocked(input: { taskId: string; nodeId: string; dryRun: boolean; includes: string[] }): Promise<RunResult> {
    const task = await this.deps.taskStore.load(input.taskId);
    const node = task.nodes[input.nodeId];
    if (node !== undefined && node.status === 'running') {
      const recovered = transitionNode(task, input.nodeId, { type: 'fail', message: '检测到节点仍处于 running 但本机执行锁已不再被持有，已自动恢复为失败状态' });
      await this.deps.taskStore.update(recovered);
      throw new TaskRunnerError('RUN_RECOVERED', '上次运行未正常结束，节点已自动标记失败；请使用 task revise 记录重试原因后重新运行');
    }
    if (node === undefined || node.phase === 'intake' || node.status !== 'ready' || node.skill === undefined) {
      throw new TaskRunnerError('NODE_NOT_RUNNABLE', '只能运行已就绪且已锁定技能的节点');
    }

    const skill = await this.loadLockedSkill(node.skill);
    if (!skill.phases.includes(node.phase)) {
      throw new TaskRunnerError('SKILL_LOCK_INVALID', '已锁定技能与当前节点阶段不兼容');
    }
    const methods = await Promise.all(node.skill.methodSources.map((source) => this.deps.methodSourceResolver.readLocked(source)));
    const manifest = await this.deps.contextBuilder.build({
      task,
      nodeId: input.nodeId,
      includes: input.includes,
      budgetInputs: [
        { label: '节点指令', content: node.title },
        { label: `技能：${skill.name}@${skill.version}`, content: skill.body },
        ...methods.map((method) => ({ label: `方法论：${method.source.id}`, content: method.content })),
      ],
    });
    await this.deps.taskFactGuard.assertCommitted({ task, projectRoot: this.deps.taskStore.projectDirectory(), paths: committedPaths(this.deps.taskStore.projectDirectory(), task, this.deps.taskStore, manifest) });
    if (!input.dryRun) {
      await this.assertWorkingTreeClean();
    }

    const runId = this.deps.runIdFactory?.() ?? randomUUID();
    const runDirectory = join(this.deps.runtimeRoot, task.id, runId);
    const scope = input.dryRun ? undefined : await this.changeScope(task, input.nodeId, runId);
    const contextManifestFactPath = `runs/${runId}/context-manifest.json`;
    await this.deps.taskStore.createFact(task.id, contextManifestFactPath, JSON.stringify(manifest, null, 2) + '\n');
    if (!input.dryRun) {
      await this.deps.taskStore.createFact(task.id, `runs/${runId}/change-baseline.json`, JSON.stringify({
        schemaVersion: 'aiw.change-baseline/v1', taskId: task.id, nodeId: input.nodeId, runId, capturedAt: new Date().toISOString(), changedPaths: [],
      }, null, 2) + '\n');
    }
    const request: RunRequest = {
      schemaVersion: 'aiw.run/v1',
      runId,
      task: { id: task.id, nodeId: input.nodeId, nodeRevision: node.revision, projectRoot: this.deps.taskStore.projectDirectory() },
      instruction: node.title,
      contextManifestPath: join(this.deps.taskStore.taskDirectory(task.id), contextManifestFactPath),
      runDirectory,
      mode: input.dryRun ? 'dry-run' : 'execute',
      artifacts: node.outputs,
      allowedChangePaths: scope?.allowedPaths ?? [],
      context: {
        skill: { name: skill.name, version: skill.version, content: skill.body },
        methodSources: methods.map((method) => ({ id: method.source.id, content: method.content })),
        files: await loadContextFiles(task, this.deps.taskStore, manifest),
      },
    };

    if (input.dryRun) {
      const result = RunResultSchema.parse({ ...(await this.deps.adapter.run(request)), contextManifest: manifest });
      await this.writeResult(task.id, runId, result);
      return result;
    }

    const startedTask = transitionNode(task, input.nodeId, { type: 'start', runId });
    await this.deps.taskStore.update(startedTask);
    if (scope === undefined) {
      throw new TaskRunnerError('NODE_NOT_RUNNABLE', '执行节点缺少变更范围');
    }
    await this.deps.taskStore.createFact(task.id, `runs/${runId}/change-scope.json`, JSON.stringify(scope, null, 2) + '\n');
    const result = RunResultSchema.parse({ ...(await this.execute(request, startedTask, input.nodeId, scope)), contextManifest: manifest });
    await this.writeResult(task.id, runId, result);
    const next = result.status === 'succeeded'
      ? transitionNode(startedTask, input.nodeId, { type: 'succeed', outputs: result.artifacts, evidencePath: `runs/${runId}/change-evidence.json` })
      : transitionNode(startedTask, input.nodeId, { type: 'fail', message: result.error?.message ?? `运行未完成：${result.status}` });
    await this.deps.taskStore.update(next);
    return result;
  }

  private async execute(request: RunRequest, task: Task, nodeId: string, scope: ChangeScope): Promise<RunResult> {
    let result: RunResult;
    try {
      result = await this.deps.adapter.run(request);
    } catch (error) {
      result = failedResult(request, 'CODEX_EXECUTION_ERROR', error instanceof Error ? error.message : 'Codex 调用失败');
    }
    if (result.status !== 'succeeded') {
      await this.recordChangeEvidence(task, request, scope, result);
      return result;
    }
    try {
      const evidence = await this.recordChangeEvidence(task, request, scope, result);
      if (evidence.violations.length > 0) {
        return failedResult(request, 'CHANGE_SCOPE_VIOLATION', `检测到超出允许范围的变更：${evidence.violations.join(', ')}`);
      }
      return RunResultSchema.parse({ ...result, artifacts: await outputRecords(task, this.deps.taskStore, nodeId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : '节点产物校验失败';
      return failedResult(request, error instanceof TaskRunnerError ? error.code : 'ARTIFACT_INVALID', message);
    }
  }

  private async assertWorkingTreeClean(): Promise<void> {
    const changed = await this.deps.changeInspector.changedPaths({ projectRoot: this.deps.taskStore.projectDirectory() });
    if (changed.length > 0) {
      throw new TaskRunnerError('WORKTREE_DIRTY', `业务仓库存在未提交变更，无法建立可信基线：${changed.join(', ')}`);
    }
  }

  private async changeScope(task: Task, nodeId: string, runId: string): Promise<ChangeScope> {
    const node = task.nodes[nodeId];
    if (node === undefined) {
      throw new TaskRunnerError('NODE_NOT_RUNNABLE', `未知节点：${nodeId}`);
    }
    const taskRoot = relative(this.deps.taskStore.projectDirectory(), this.deps.taskStore.taskDirectory(task.id)).replaceAll('\\', '/');
    const allowedPaths = [
      `${taskRoot}/task.yaml`,
      `${taskRoot}/runs/${runId}/**`,
      ...node.outputs.map((path) => `${taskRoot}/${path}`),
      ...(node.phase === 'implement' ? await implementationAllowedPaths(task, this.deps.taskStore) : []),
    ];
    if (node.phase === 'implement' && allowedPaths.length === 2 + node.outputs.length) {
      throw new TaskRunnerError('CHANGE_SCOPE_MISSING', '实施计划未声明允许变更范围');
    }
    return { schemaVersion: 'aiw.change-scope/v1', taskId: task.id, nodeId, runId, allowedPaths };
  }

  private async recordChangeEvidence(task: Task, request: RunRequest, scope: ChangeScope, result: RunResult): Promise<ChangeEvidence> {
    const changedPaths = await this.deps.changeInspector.changedPaths({ projectRoot: this.deps.taskStore.projectDirectory() });
    const violations = changedPaths.filter((path) => !scope.allowedPaths.some((allowed) => matchesAllowedPath(path, allowed)));
    const rawDiff = await this.deps.changeInspector.diff({ projectRoot: this.deps.taskStore.projectDirectory() });
    const changedFiles = await Promise.all(changedPaths.map(async (path) => ({ path, ...(await fileHash(this.deps.taskStore.projectDirectory(), path)) })));
    const evidence: ChangeEvidence = {
      schemaVersion: 'aiw.change-evidence/v1', taskId: task.id, nodeId: scope.nodeId, runId: request.runId,
      baseline: { path: `runs/${request.runId}/change-baseline.json`, changedPaths: [] },
      changedPaths, violations, changedFiles,
      diff: { sha256: createHash('sha256').update(rawDiff).digest('hex'), lineCount: rawDiff === '' ? 0 : rawDiff.split(/\r?\n/).length - 1 },
      ...(result.process === undefined ? {} : { process: result.process }),
    };
    await this.deps.taskStore.createFact(task.id, `runs/${request.runId}/change-diff.json`, JSON.stringify({ schemaVersion: 'aiw.change-diff/v1', taskId: task.id, runId: request.runId, changedPaths, violations }, null, 2) + '\n');
    await this.deps.taskStore.createFact(task.id, `runs/${request.runId}/change-evidence.json`, JSON.stringify(evidence, null, 2) + '\n');
    return evidence;
  }

  private async loadLockedSkill(lock: SkillLock) {
    const skill = await this.deps.skillRegistry.findLocked(lock);
    if (skill === undefined || !sameSkillLock(skill, lock)) {
      throw new TaskRunnerError('SKILL_LOCK_INVALID', '已锁定技能在本地注册表中不存在或内容已变化');
    }
    return skill;
  }

  private async writeResult(taskId: string, runId: string, result: RunResult): Promise<void> {
    const sharedResult = {
      schemaVersion: result.schemaVersion,
      runId: result.runId,
      status: result.status,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      ...(result.process === undefined ? {} : { process: result.process }),
      artifacts: result.artifacts,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
    await this.deps.taskStore.createFact(taskId, `runs/${runId}/result.json`, JSON.stringify(sharedResult, null, 2) + '\n');
  }
}

interface ChangeScope {
  schemaVersion: 'aiw.change-scope/v1';
  taskId: string;
  nodeId: string;
  runId: string;
  allowedPaths: string[];
}

interface ChangeEvidence {
  schemaVersion: 'aiw.change-evidence/v1';
  taskId: string;
  nodeId: string;
  runId: string;
  baseline: { path: string; changedPaths: string[] };
  changedPaths: string[];
  violations: string[];
  changedFiles: Array<{ path: string; sha256?: string; deleted?: true }>;
  diff: { sha256: string; lineCount: number };
  process?: unknown;
}

async function implementationAllowedPaths(task: Task, taskStore: TaskStore): Promise<string[]> {
  const planPath = join(taskStore.taskDirectory(task.id), 'artifacts', 'implementation-plan.md');
  const content = await readFile(planPath, 'utf8');
  const match = /```ya?ml\s*\n([\s\S]*?)```/i.exec(content);
  if (match === null) {
    return [];
  }
  const allowed = Array.from(match[1].matchAll(/^\s*-\s*([^\s#]+)\s*$/gm), (entry) => entry[1])
    .filter((path) => path !== 'allowedPaths:' && isAllowedBusinessPath(path));
  return [...new Set(allowed)];
}

function isAllowedBusinessPath(path: string): boolean {
  return !path.startsWith('.') && !path.startsWith('/') && !path.split('/').includes('..');
}

function matchesAllowedPath(path: string, allowed: string): boolean {
  return allowed.endsWith('/**') ? path.startsWith(allowed.slice(0, -2)) : path === allowed;
}

async function loadContextFiles(task: Task, taskStore: TaskStore, manifest: ContextManifest): Promise<RunRequest['context']['files']> {
  return Promise.all(manifest.files.map(async (file) => {
    const absolutePath = file.role === 'additional'
      ? join(task.repository, file.path)
      : join(taskStore.taskDirectory(task.id), file.path);
    const content = await readFile(absolutePath, 'utf8');
    const hash = createHash('sha256').update(content, 'utf8').digest('hex');
    if (hash !== file.sha256) {
      throw new TaskRunnerError('SKILL_LOCK_INVALID', `上下文文件在构建后发生变化：${file.path}`);
    }
    return { role: file.role, path: file.path, content };
  }));
}

async function outputRecords(task: Task, taskStore: TaskStore, nodeId: string): Promise<OutputRecord[]> {
  const node = task.nodes[nodeId];
  if (node === undefined) {
    throw new TaskRunnerError('ARTIFACT_MISSING', `未知节点：${nodeId}`);
  }
  return Promise.all(node.outputs.map(async (path) => {
    let content: Buffer;
    try {
      content = await readFile(join(taskStore.taskDirectory(task.id), path));
    } catch {
      throw new TaskRunnerError('ARTIFACT_MISSING', `节点未生成声明产物：${path}`);
    }
    validateArtifactContent(node, path, content.toString('utf8'));
    return { path, sha256: createHash('sha256').update(content).digest('hex') };
  }));
}

function validateArtifactContent(node: NonNullable<Task['nodes'][string]>, path: string, content: string): void {
  if (content.trim().length < 24 || !/^#\s+.+/m.test(content)) {
    throw new TaskRunnerError('ARTIFACT_INVALID', `节点产物内容不足或缺少一级标题：${path}`);
  }
  if (node.phase === 'plan' && !/```ya?ml\s*\n[\s\S]*?allowedPaths:\s*\n\s*-\s*[^\s#]+/i.test(content)) {
    throw new TaskRunnerError('ARTIFACT_INVALID', '实施计划必须声明含至少一个路径的 allowedPaths YAML 代码块');
  }
  if (node.phase === 'test' && (!/测试命令|test command/i.test(content) || !/测试结果|结果|result/i.test(content))) {
    throw new TaskRunnerError('ARTIFACT_INVALID', '测试报告必须包含测试命令与测试结果');
  }
}

async function fileHash(projectRoot: string, path: string): Promise<{ sha256?: string; deleted?: true }> {
  try {
    const absolutePath = join(projectRoot, path);
    if (!(await stat(absolutePath)).isFile()) {
      return { deleted: true };
    }
    return { sha256: createHash('sha256').update(await readFile(absolutePath)).digest('hex') };
  } catch {
    return { deleted: true };
  }
}

function committedPaths(projectRoot: string, task: Task, taskStore: TaskStore, manifest: ContextManifest): string[] {
  const taskRoot = relative(projectRoot, taskStore.taskDirectory(task.id)).replaceAll('\\', '/');
  if (taskRoot.startsWith('../') || taskRoot === '') {
    throw new TaskRunnerError('NODE_NOT_RUNNABLE', '任务目录必须位于业务仓库内');
  }
  const taskFactPath = (path: string): string => `${taskRoot}/${path}`;
  return [
    taskFactPath('task.yaml'),
    ...task.approvalRefs.map(taskFactPath),
    ...manifest.files.map((file) => file.role === 'additional' ? file.path : taskFactPath(file.path)),
  ];
}

function sameSkillLock(skill: { registrySource: SkillLock['registrySource']; sha256: string; methodSources: SkillLock['methodSources'] }, lock: SkillLock): boolean {
  return skill.registrySource.url === lock.registrySource.url
    && skill.registrySource.revision === lock.registrySource.revision
    && skill.sha256 === lock.sha256
    && JSON.stringify(skill.methodSources) === JSON.stringify(lock.methodSources);
}

function failedResult(request: RunRequest, code: string, message: string): RunResult {
  return RunResultSchema.parse({
    schemaVersion: 'aiw.run-result/v1',
    runId: request.runId,
    status: 'failed',
    runDirectory: request.runDirectory,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    artifacts: [],
    error: { code, message },
  });
}
