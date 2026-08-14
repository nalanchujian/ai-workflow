import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { CodexAdapter } from '../adapters/codex-adapter.js';
import { RunResultSchema, type RunRequest, type RunResult } from '../domain/run.js';
import type { ContextManifest } from '../domain/context.js';
import type { OutputRecord, SkillLock, Task } from '../domain/task.js';
import type { MethodSourceResolverPort } from '../ports/method-source-resolver.js';
import type { WorkingTreeStatus } from '../ports/repository-status.js';
import { ContextBuilder } from './context-builder.js';
import { ImplementationWorkPlannerError, validateWorkBreakdown } from './implementation-work-planner.js';
import { SkillRegistry } from './skill-registry.js';
import { TaskFactGuard } from './task-fact-guard.js';
import { FileTaskRunLock, type TaskRunLock } from './task-run-lock.js';
import { transitionNode } from './task-state-machine.js';
import { TaskStore } from './task-store.js';
import { loadRunCompletionBundle } from './run-completion-bundle.js';

export class TaskRunnerError extends Error {
  constructor(readonly code: 'NODE_NOT_RUNNABLE' | 'TASK_BUSY' | 'SKILL_LOCK_INVALID' | 'ARTIFACT_MISSING' | 'ARTIFACT_INVALID' | 'ARTIFACT_STALE' | 'WORKTREE_DIRTY' | 'CHANGE_SCOPE_MISSING' | 'RUN_RECOVERED', message: string) {
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
    await this.deps.taskFactGuard.assertCommitted({ task, projectRoot: this.deps.taskStore.projectDirectory(), paths: await committedPaths(this.deps.taskStore.projectDirectory(), task, this.deps.taskStore, input.nodeId, manifest) });
    if (!input.dryRun) {
      await this.assertWorkingTreeClean();
    }

    const runId = this.deps.runIdFactory?.() ?? randomUUID();
    const runDirectory = join(this.deps.runtimeRoot, task.id, runId);
    const scope = input.dryRun ? undefined : await this.changeScope(task, input.nodeId, runId);
    const contextManifestFactPath = `runs/${runId}/context-manifest.json`;
    await this.deps.taskStore.createFact(task.id, contextManifestFactPath, JSON.stringify(manifest, null, 2) + '\n');
    const baseline: ChangeBaseline = {
      path: `runs/${runId}/change-baseline.json`,
      changedPaths: [],
      outputs: input.dryRun ? [] : await outputBaseline(task, this.deps.taskStore, input.nodeId),
      ...(input.dryRun ? {} : { git: await this.deps.changeInspector.revision({ projectRoot: this.deps.taskStore.projectDirectory() }) }),
    };
    if (!input.dryRun) {
      await this.deps.taskStore.createFact(task.id, baseline.path, JSON.stringify({
        schemaVersion: 'aiw.change-baseline/v1', taskId: task.id, nodeId: input.nodeId, runId, capturedAt: new Date().toISOString(), changedPaths: baseline.changedPaths, outputs: baseline.outputs, ...(baseline.git === undefined ? {} : { git: baseline.git }),
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
    const result = RunResultSchema.parse({ ...(await this.execute(request, startedTask, input.nodeId, scope, baseline)), contextManifest: manifest });
    await this.writeResult(task.id, runId, result);
    const next = result.status === 'succeeded'
      ? transitionNode(startedTask, input.nodeId, { type: 'succeed', runId, outputs: result.artifacts, evidencePath: `runs/${runId}/change-evidence.json` })
      : result.status === 'cancelled'
        ? transitionNode(startedTask, input.nodeId, { type: 'cancel', note: result.error?.message ?? '已取消当前运行' })
        : transitionNode(startedTask, input.nodeId, { type: 'fail', message: result.error?.message ?? `运行未完成：${result.status}` });
    await this.deps.taskStore.update(next);
    return result;
  }

  private async execute(request: RunRequest, task: Task, nodeId: string, scope: ChangeScope, baseline: ChangeBaseline): Promise<RunResult> {
    if (await cancellationRequested(request.runDirectory)) {
      return cancelledResult(request, '已收到取消请求，未启动 Codex');
    }
    let result: RunResult;
    try {
      result = await this.deps.adapter.run(request, {
        onProcessStarted: async (processId) => {
          await writeFile(join(request.runDirectory, 'process.json'), JSON.stringify({ processId, startedAt: new Date().toISOString() }) + '\n', 'utf8');
        },
      });
    } catch (error) {
      result = failedResult(request, 'CODEX_EXECUTION_ERROR', error instanceof Error ? error.message : 'Codex 调用失败');
    }
    if (await cancellationRequested(request.runDirectory)) {
      result = cancelledResult(request, '已取消当前 Codex 运行');
    }
    if (result.status !== 'succeeded') {
      await this.persistChangeEvidence(task, {
        ...(await this.recordChangeEvidence(task, request, scope, result, baseline)),
        failure: failureEvidence(result.status === 'cancelled' ? 'cancelled' : 'adapter', result.error?.code ?? 'CODEX_EXECUTION_ERROR', result.error?.message ?? `运行未完成：${result.status}`),
      });
      return result;
    }
    let evidence: ChangeEvidence | undefined;
    try {
      evidence = await this.recordChangeEvidence(task, request, scope, result, baseline);
      if (evidence.git.historyChanged) {
        const message = '检测到 Codex 修改了 Git 提交或分支，当前运行已停止';
        await this.persistChangeEvidence(task, { ...evidence, failure: failureEvidence('git-history', 'GIT_HISTORY_MUTATION', message) });
        return failedResult(request, 'GIT_HISTORY_MUTATION', message);
      }
      if (evidence.violations.length > 0) {
        const message = `检测到超出允许范围的变更：${evidence.violations.join(', ')}`;
        await this.persistChangeEvidence(task, { ...evidence, failure: failureEvidence('scope', 'CHANGE_SCOPE_VIOLATION', message) });
        return failedResult(request, 'CHANGE_SCOPE_VIOLATION', message);
      }
      const artifacts = await outputRecords(task, this.deps.taskStore, nodeId, baseline.outputs);
      await this.persistChangeEvidence(task, { ...evidence, artifacts });
      return RunResultSchema.parse({ ...result, artifacts });
    } catch (error) {
      const message = error instanceof Error ? error.message : '节点产物校验失败';
      const code = error instanceof TaskRunnerError ? error.code : 'ARTIFACT_INVALID';
      const captured = evidence ?? await this.recordChangeEvidence(task, request, scope, result, baseline);
      await this.persistChangeEvidence(task, { ...captured, failure: failureEvidence('artifact', code, message) });
      return failedResult(request, code, message);
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
      ...(node.phase === 'implement' ? (node.allowedPaths ?? []) : []),
    ];
    if (node.phase === 'implement' && allowedPaths.length === 2 + node.outputs.length) {
      throw new TaskRunnerError('CHANGE_SCOPE_MISSING', '实施计划未声明允许变更范围');
    }
    return { schemaVersion: 'aiw.change-scope/v1', taskId: task.id, nodeId, runId, allowedPaths };
  }

  private async recordChangeEvidence(task: Task, request: RunRequest, scope: ChangeScope, result: RunResult, baseline: ChangeBaseline, artifacts?: OutputRecord[]): Promise<ChangeEvidence> {
    const projectRoot = this.deps.taskStore.projectDirectory();
    const changedPaths = await this.deps.changeInspector.changedPaths({ projectRoot });
    const violations = changedPaths.filter((path) => !scope.allowedPaths.some((allowed) => matchesAllowedPath(path, allowed)));
    const rawDiff = await this.deps.changeInspector.diff({ projectRoot });
    const untrackedPaths = await this.deps.changeInspector.untrackedPaths({ projectRoot });
    const changedFiles = await Promise.all(changedPaths.map(async (path) => ({ path, ...(await fileHash(projectRoot, path)) })));
    const after = await this.deps.changeInspector.revision({ projectRoot });
    const allowedUntracked = untrackedPaths.filter((path) => scope.allowedPaths.some((allowed) => matchesAllowedPath(path, allowed)));
    const patch = `${rawDiff}${await untrackedPatch(projectRoot, allowedUntracked)}`;
    const evidence: ChangeEvidence = {
      schemaVersion: 'aiw.change-evidence/v1', taskId: task.id, nodeId: scope.nodeId, runId: request.runId,
      baseline,
      changedPaths, violations, changedFiles,
      untrackedPaths,
      git: { before: baseline.git ?? {}, after, historyChanged: !sameGitRevision(baseline.git, after) },
      patch,
      diff: { sha256: createHash('sha256').update(patch).digest('hex'), lineCount: patch === '' ? 0 : patch.split(/\r?\n/).length - 1 },
      ...(result.process === undefined ? {} : { process: result.process }),
      ...(artifacts === undefined ? {} : { artifacts }),
    };
    return evidence;
  }

  private async persistChangeEvidence(task: Task, evidence: ChangeEvidence): Promise<void> {
    const { patch, ...sharedEvidence } = evidence;
    await this.deps.taskStore.createFact(task.id, `runs/${evidence.runId}/change.patch`, patch);
    await this.deps.taskStore.createFact(task.id, `runs/${evidence.runId}/change-diff.json`, JSON.stringify({ schemaVersion: 'aiw.change-diff/v1', taskId: task.id, runId: evidence.runId, changedPaths: evidence.changedPaths, untrackedPaths: evidence.untrackedPaths, violations: evidence.violations, patchSha256: evidence.diff.sha256 }, null, 2) + '\n');
    await this.deps.taskStore.createFact(task.id, `runs/${evidence.runId}/change-evidence.json`, JSON.stringify(sharedEvidence, null, 2) + '\n');
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
  baseline: ChangeBaseline;
  changedPaths: string[];
  violations: string[];
  changedFiles: Array<{ path: string; sha256?: string; deleted?: true }>;
  untrackedPaths: string[];
  git: { before: { head?: string; branch?: string }; after: { head?: string; branch?: string }; historyChanged: boolean };
  patch: string;
  diff: { sha256: string; lineCount: number };
  process?: unknown;
  artifacts?: OutputRecord[];
  failure?: { stage: 'adapter' | 'scope' | 'artifact' | 'git-history' | 'cancelled'; code: string; message: string };
}

interface ChangeBaseline {
  path: string;
  changedPaths: string[];
  outputs: Array<{ path: string; sha256?: string }>;
  git?: { head?: string; branch?: string };
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

async function outputRecords(task: Task, taskStore: TaskStore, nodeId: string, baseline: ChangeBaseline['outputs']): Promise<OutputRecord[]> {
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
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (baseline.find((entry) => entry.path === path)?.sha256 === sha256) {
      throw new TaskRunnerError('ARTIFACT_STALE', `节点产物未在本次运行中更新：${path}`);
    }
    return { path, sha256 };
  }));
}

async function outputBaseline(task: Task, taskStore: TaskStore, nodeId: string): Promise<ChangeBaseline['outputs']> {
  const node = task.nodes[nodeId];
  if (node === undefined) {
    throw new TaskRunnerError('ARTIFACT_MISSING', `未知节点：${nodeId}`);
  }
  return Promise.all(node.outputs.map(async (path) => {
    const hash = await fileHash(taskStore.taskDirectory(task.id), path);
    return { path, ...(hash.sha256 === undefined ? {} : { sha256: hash.sha256 }) };
  }));
}

function validateArtifactContent(node: NonNullable<Task['nodes'][string]>, path: string, content: string): void {
  if (path === 'artifacts/work-breakdown.yaml') {
    try {
      validateWorkBreakdown(content);
      return;
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', error instanceof ImplementationWorkPlannerError ? error.message : '实施工作单元声明无效');
    }
  }
  if (path === 'artifacts/implementation-context.md' && Buffer.byteLength(content, 'utf8') > 16_000) {
    throw new TaskRunnerError('ARTIFACT_INVALID', '实施上下文摘要超过 4000 tokens 预算，必须压缩后重新生成计划');
  }
  if (content.trim().length < 24 || !/^#\s+.+/m.test(content)) {
    throw new TaskRunnerError('ARTIFACT_INVALID', `节点产物内容不足或缺少一级标题：${path}`);
  }
  if (path === 'artifacts/implementation-plan.md' && !/```ya?ml\s*\n[\s\S]*?allowedPaths:\s*\n\s*-\s*[^\s#]+/i.test(content)) {
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

async function committedPaths(projectRoot: string, task: Task, taskStore: TaskStore, nodeId: string, manifest: ContextManifest): Promise<string[]> {
  const taskRoot = relative(projectRoot, taskStore.taskDirectory(task.id)).replaceAll('\\', '/');
  if (taskRoot.startsWith('../') || taskRoot === '') {
    throw new TaskRunnerError('NODE_NOT_RUNNABLE', '任务目录必须位于业务仓库内');
  }
  const taskFactPath = (path: string): string => `${taskRoot}/${path}`;
  const completedDependencies = dependencyClosure(task, nodeId)
    .filter((dependency) => task.nodes[dependency]?.phase !== 'intake');
  const bundles = await Promise.all(completedDependencies.map((dependency) => loadRunCompletionBundle(task, taskStore, dependency)));
  return [
    taskFactPath('task.yaml'),
    ...task.approvalRefs.map(taskFactPath),
    ...bundles.flatMap((bundle) => bundle.paths.map(taskFactPath)),
    ...manifest.files.map((file) => file.role === 'additional' ? file.path : taskFactPath(file.path)),
  ];
}

function dependencyClosure(task: Task, nodeId: string): string[] {
  const node = task.nodes[nodeId];
  if (node === undefined) return [];
  const dependencies = new Set<string>();
  const visit = (candidate: string): void => {
    if (dependencies.has(candidate)) return;
    dependencies.add(candidate);
    for (const dependency of task.nodes[candidate]?.dependsOn ?? []) visit(dependency);
  };
  for (const dependency of node.dependsOn) visit(dependency);
  return [...dependencies];
}

function failureEvidence(stage: NonNullable<ChangeEvidence['failure']>['stage'], code: string, message: string): NonNullable<ChangeEvidence['failure']> {
  return { stage, code, message };
}

function sameGitRevision(left: ChangeBaseline['git'], right: { head?: string; branch?: string }): boolean {
  return left?.head === right.head && left?.branch === right.branch;
}

async function untrackedPatch(projectRoot: string, paths: string[]): Promise<string> {
  const patches = await Promise.all(paths.map(async (path) => {
    try {
      const content = await readFile(join(projectRoot, path));
      if (content.byteLength > 1024 * 1024 || content.includes(0)) {
        return `# 未记录内容：${path}（文件为二进制或超过 1 MiB）\n`;
      }
      const body = content.toString('utf8').split(/\r?\n/).map((line) => `+${line}`).join('\n');
      return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n${body}\n`;
    } catch {
      return `# 无法读取未跟踪文件：${path}\n`;
    }
  }));
  return patches.join('');
}

async function cancellationRequested(runDirectory: string): Promise<boolean> {
  try {
    await stat(join(runDirectory, 'cancel-request.json'));
    return true;
  } catch {
    return false;
  }
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

function cancelledResult(request: RunRequest, message: string): RunResult {
  return RunResultSchema.parse({
    schemaVersion: 'aiw.run-result/v1',
    runId: request.runId,
    status: 'cancelled',
    runDirectory: request.runDirectory,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    artifacts: [],
    error: { code: 'AIW_CANCELLED', message },
  });
}
