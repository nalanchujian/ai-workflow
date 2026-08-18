import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { CodexAdapter } from '../adapters/codex-adapter.js';
import { RunResultSchema, type RunRequest, type RunResult } from '../domain/run.js';
import type { ContextManifest } from '../domain/context.js';
import { registeredDecisionFactPaths, type OutputRecord, type SkillLock, type Task } from '../domain/task.js';
import { handoffPath, outputPathsForNextRun, validateHandoff } from '../domain/handoff.js';
import { hasTestExecutionEvidence } from '../domain/test-report.js';
import { AcceptanceResultsSchema } from '../domain/acceptance-results.js';
import { AcceptanceCatalogSchema } from '../domain/acceptance-catalog.js';
import { DecisionRegisterSchema } from '../domain/decision-register.js';
import { formatSchemaDiagnostics } from '../domain/schema-diagnostics.js';
import { validateMarkdownArtifactContract } from '../domain/artifact-contracts.js';
import { parse } from 'yaml';
import type { MethodSourceResolverPort } from '../ports/method-source-resolver.js';
import type { WorkingTreeStatus } from '../ports/repository-status.js';
import { ContextBuilder } from './context-builder.js';
import { ImplementationWorkPlannerError, validateWorkBreakdown } from './implementation-work-planner.js';
import { SkillRegistry } from './skill-registry.js';
import { TaskFactGuard } from './task-fact-guard.js';
import { FileTaskRunLock, type TaskRunLock } from './task-run-lock.js';
import { invalidateNodeAndDependents, overwriteCleanupPaths, transitionNode } from './task-state-machine.js';
import { TaskStore } from './task-store.js';
import { loadRunCompletionBundle } from './run-completion-bundle.js';

export class TaskRunnerError extends Error {
  constructor(readonly code: 'NODE_NOT_RUNNABLE' | 'TASK_BUSY' | 'SKILL_LOCK_INVALID' | 'ARTIFACT_MISSING' | 'ARTIFACT_INVALID' | 'ARTIFACT_STALE' | 'WORKTREE_DIRTY' | 'RUN_RECOVERED', message: string) {
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
      throw new TaskRunnerError('RUN_RECOVERED', '上次运行未正常结束，节点已自动标记失败；提交失败证据后可直接再次执行 task run 重试');
    }
    const canOverwrite = node !== undefined && node.phase !== 'intake' && ['completed', 'awaiting_approval', 'cancelled', 'invalidated'].includes(node.status);
    if (node === undefined || node.phase === 'intake' || (!['ready', 'failed'].includes(node.status) && !canOverwrite) || node.skill === undefined) {
      throw new TaskRunnerError('NODE_NOT_RUNNABLE', '只能运行已就绪、可重试、已完成、待审批或已失效节点');
    }

    await this.assertUpstreamIntegrity(task, input.nodeId);
    const skill = await this.loadLockedSkill(node.skill);
    if (!skill.phases.includes(node.phase)) {
      throw new TaskRunnerError('SKILL_LOCK_INVALID', '已锁定技能与当前节点阶段不兼容');
    }
    const methods = await Promise.all(node.skill.methodSources.map((source) => this.deps.methodSourceResolver.readLocked(source)));
    const outputPaths = outputPathsForNextRun(input.nodeId, node);
    const manifest = await this.deps.contextBuilder.build({
      task,
      nodeId: input.nodeId,
      includes: input.includes,
      budgetInputs: [
        { category: 'node-instruction', label: '节点指令', content: node.title },
        { category: 'skill', label: `技能：${skill.name}@${skill.version}`, content: skill.body },
        ...methods.map((method) => ({ category: 'method-source' as const, label: `方法论：${method.source.id}`, content: method.content })),
      ],
      enforceBudget: false,
    });
    await this.deps.taskFactGuard.assertCommitted({ task, projectRoot: this.deps.taskStore.projectDirectory(), paths: await committedPaths(this.deps.taskStore.projectDirectory(), task, this.deps.taskStore, input.nodeId, manifest) });
    if (!input.dryRun) {
      await this.assertWorkingTreeClean();
    }

    const runId = this.deps.runIdFactory?.() ?? randomUUID();
    const runDirectory = join(this.deps.runtimeRoot, task.id, runId);
    const scope = input.dryRun ? undefined : await this.taskFactWriteScope(task, input.nodeId, runId);
    const contextManifestFactPath = `runs/${runId}/context-manifest.json`;
    const request: RunRequest = {
      schemaVersion: 'aiw.run/v2',
      runId,
      task: { id: task.id, nodeId: input.nodeId, phase: node.phase, nodeRevision: node.revision, projectRoot: this.deps.taskStore.projectDirectory() },
      instruction: node.title,
      contextManifestPath: join(this.deps.taskStore.taskDirectory(task.id), contextManifestFactPath),
      runDirectory,
      mode: input.dryRun ? 'dry-run' : 'execute',
      artifacts: outputPaths,
      context: {
        skill: { name: skill.name, version: skill.version, content: skill.body },
        methodSources: methods.map((method) => ({ id: method.source.id, content: method.content })),
        files: await loadContextFiles(task, this.deps.taskStore, manifest),
      },
    };
    const finalizedManifest = this.deps.contextBuilder.finalizePromptBudget({
      manifest,
      prompt: this.deps.adapter.renderPrompt(request),
    });
    await this.deps.taskStore.createFact(task.id, contextManifestFactPath, JSON.stringify(finalizedManifest, null, 2) + '\n');
    if (!input.dryRun && canOverwrite) {
      await this.deps.taskStore.removeFacts(task.id, overwriteCleanupPaths(task, input.nodeId));
    }
    const baseline: ChangeBaseline = {
      path: `runs/${runId}/change-baseline.json`,
      changedPaths: [],
      outputs: input.dryRun ? [] : await outputBaseline(task, this.deps.taskStore, input.nodeId, outputPaths),
      ...(input.dryRun ? {} : { git: await this.deps.changeInspector.revision({ projectRoot: this.deps.taskStore.projectDirectory() }) }),
    };
    if (!input.dryRun) {
      await this.deps.taskStore.createFact(task.id, baseline.path, JSON.stringify({
        schemaVersion: 'aiw.change-baseline/v1', taskId: task.id, nodeId: input.nodeId, runId, capturedAt: new Date().toISOString(), changedPaths: baseline.changedPaths, outputs: baseline.outputs, ...(baseline.git === undefined ? {} : { git: baseline.git }),
      }, null, 2) + '\n');
    }

    if (input.dryRun) {
      const result = RunResultSchema.parse({ ...(await this.deps.adapter.run(request)), contextManifest: finalizedManifest });
      await this.writeResult(task.id, runId, result);
      return result;
    }

    const startedTask = transitionNode(task, input.nodeId, { type: 'start', runId });
    await this.deps.taskStore.update(startedTask);
    if (scope === undefined) throw new TaskRunnerError('NODE_NOT_RUNNABLE', '执行节点缺少任务事实写入边界');
    await this.deps.taskStore.createFact(task.id, `runs/${runId}/change-scope.json`, JSON.stringify(scope, null, 2) + '\n');
    const result = RunResultSchema.parse({ ...(await this.execute(request, startedTask, input.nodeId, scope, baseline, finalizedManifest)), contextManifest: finalizedManifest });
    await this.writeResult(task.id, runId, result);
    const next = result.status === 'succeeded'
      ? transitionNode(startedTask, input.nodeId, { type: 'succeed', runId, outputs: result.artifacts, evidencePath: `runs/${runId}/change-evidence.json` })
      : result.status === 'cancelled'
        ? transitionNode(startedTask, input.nodeId, { type: 'cancel', note: result.error?.message ?? '已取消当前运行' })
        : transitionNode(startedTask, input.nodeId, { type: 'fail', message: result.error?.message ?? `运行未完成：${result.status}` });
    await this.deps.taskStore.update(next);
    return result;
  }

  private async execute(
    request: RunRequest,
    task: Task,
    nodeId: string,
    scope: TaskFactWriteScope,
    baseline: ChangeBaseline,
    manifest: ContextManifest,
  ): Promise<RunResult> {
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
      if (evidence.taskFactViolations.length > 0) {
        const expectedHandoff = request.artifacts.find((path) => path.startsWith(`handoffs/${nodeId}/`) && path.endsWith('.yaml'));
        const staleHandoffs = evidence.taskFactViolations.filter((path) => path.startsWith(`.aiw/tasks/${task.id}/handoffs/${nodeId}/`));
        const message = staleHandoffs.length === 0
          ? `检测到不允许写入的任务事实：${evidence.taskFactViolations.join(', ')}`
          : `检测到写入旧交接包：${staleHandoffs.join(', ')}。本次运行只允许写入 ${expectedHandoff ?? '当前 revision 的交接包'}；请勿根据节点的历史 revision 重写旧文件。`;
        await this.persistChangeEvidence(task, { ...evidence, failure: failureEvidence('task-facts', 'TASK_FACT_WRITE_VIOLATION', message) });
        return failedResult(request, 'TASK_FACT_WRITE_VIOLATION', message);
      }
      const artifacts = await outputRecords(task, this.deps.taskStore, nodeId, baseline.outputs, manifest);
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

  private async assertUpstreamIntegrity(task: Task, nodeId: string): Promise<void> {
    const completedDependencies = dependencyClosure(task, nodeId)
      .filter((dependency) => task.nodes[dependency]?.phase !== 'intake' && task.nodes[dependency]?.status === 'completed');
    for (const dependency of completedDependencies) {
      try {
        await loadRunCompletionBundle(task, this.deps.taskStore, dependency);
      } catch (error) {
        const reason = error instanceof Error ? error.message : '上游运行完成包无法验证';
        await this.deps.taskStore.update(invalidateNodeAndDependents(task, dependency, '完成产物完整性校验失败：' + reason));
        throw new TaskRunnerError(
          'ARTIFACT_STALE',
          '上游节点 ' + dependency + ' 的当前产物与完成运行或审批记录不一致，已标记失效：' + reason,
        );
      }
    }
  }

  private async taskFactWriteScope(task: Task, nodeId: string, runId: string): Promise<TaskFactWriteScope> {
    const node = task.nodes[nodeId];
    if (node === undefined) {
      throw new TaskRunnerError('NODE_NOT_RUNNABLE', `未知节点：${nodeId}`);
    }
    const taskRoot = relative(this.deps.taskStore.projectDirectory(), this.deps.taskStore.taskDirectory(task.id)).replaceAll('\\', '/');
    const outputPaths = outputPathsForNextRun(nodeId, node);
    const allowedTaskPaths = [
      `${taskRoot}/task.yaml`,
      `${taskRoot}/runs/${runId}/**`,
      ...outputPaths.map((path) => `${taskRoot}/${path}`),
    ];
    return {
      schemaVersion: 'aiw.change-scope/v2',
      taskId: task.id,
      nodeId,
      runId,
      businessFilePolicy: 'unrestricted',
      allowedTaskPaths,
    };
  }

  private async recordChangeEvidence(task: Task, request: RunRequest, scope: TaskFactWriteScope, result: RunResult, baseline: ChangeBaseline, artifacts?: OutputRecord[]): Promise<ChangeEvidence> {
    const projectRoot = this.deps.taskStore.projectDirectory();
    const changedPaths = await this.deps.changeInspector.changedPaths({ projectRoot });
    const taskFactViolations = changedPaths.filter((path) => path.startsWith('.aiw/') && !scope.allowedTaskPaths.some((allowed) => matchesAllowedPath(path, allowed)));
    const rawDiff = await this.deps.changeInspector.diff({ projectRoot });
    const untrackedPaths = await this.deps.changeInspector.untrackedPaths({ projectRoot });
    const changedFiles = await Promise.all(changedPaths.map(async (path) => ({ path, ...(await fileHash(projectRoot, path)) })));
    const after = await this.deps.changeInspector.revision({ projectRoot });
    const patch = `${rawDiff}${await untrackedPatch(projectRoot, untrackedPaths)}`;
    const evidence: ChangeEvidence = {
      schemaVersion: 'aiw.change-evidence/v2', taskId: task.id, nodeId: scope.nodeId, runId: request.runId,
      baseline,
      changedPaths, taskFactViolations, changedFiles,
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
    await this.deps.taskStore.createFact(task.id, `runs/${evidence.runId}/change-diff.json`, JSON.stringify({ schemaVersion: 'aiw.change-diff/v2', taskId: task.id, runId: evidence.runId, changedPaths: evidence.changedPaths, untrackedPaths: evidence.untrackedPaths, taskFactViolations: evidence.taskFactViolations, patchSha256: evidence.diff.sha256 }, null, 2) + '\n');
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

interface TaskFactWriteScope {
  schemaVersion: 'aiw.change-scope/v2';
  taskId: string;
  nodeId: string;
  runId: string;
  businessFilePolicy: 'unrestricted';
  allowedTaskPaths: string[];
}

interface ChangeEvidence {
  schemaVersion: 'aiw.change-evidence/v2';
  taskId: string;
  nodeId: string;
  runId: string;
  baseline: ChangeBaseline;
  changedPaths: string[];
  taskFactViolations: string[];
  changedFiles: Array<{ path: string; sha256?: string; deleted?: true }>;
  untrackedPaths: string[];
  git: { before: { head?: string; branch?: string }; after: { head?: string; branch?: string }; historyChanged: boolean };
  patch: string;
  diff: { sha256: string; lineCount: number };
  process?: unknown;
  artifacts?: OutputRecord[];
  failure?: { stage: 'adapter' | 'task-facts' | 'artifact' | 'git-history' | 'cancelled'; code: string; message: string };
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

async function outputRecords(
  task: Task,
  taskStore: TaskStore,
  nodeId: string,
  baseline: ChangeBaseline['outputs'],
  manifest: ContextManifest | undefined,
): Promise<OutputRecord[]> {
  const node = task.nodes[nodeId];
  if (node === undefined) {
    throw new TaskRunnerError('ARTIFACT_MISSING', `未知节点：${nodeId}`);
  }
  const outputPaths = outputPathsForNextRun(nodeId, node);
  if (manifest === undefined) {
    throw new TaskRunnerError('ARTIFACT_INVALID', '本次运行缺少上下文清单，无法校验交接包证据');
  }
  const evidencePaths = handoffEvidencePaths(task, nodeId, manifest);
  const artifacts = await Promise.all(outputPaths.map(async (path) => {
    let content: Buffer;
    try {
      content = await readFile(join(taskStore.taskDirectory(task.id), path));
    } catch {
      throw new TaskRunnerError('ARTIFACT_MISSING', `节点未生成声明产物：${path}`);
    }
    validateArtifactContent(task, nodeId, path, content.toString('utf8'), evidencePaths);
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (baseline.find((entry) => entry.path === path)?.sha256 === sha256) {
      throw new TaskRunnerError('ARTIFACT_STALE', `节点产物未在本次运行中更新：${path}`);
    }
    return { path, sha256, content: content.toString('utf8') };
  }));
  await validateArtifactSet(task, taskStore, nodeId, new Map(artifacts.map((artifact) => [artifact.path, artifact.content])));
  return artifacts.map(({ path, sha256 }) => ({ path, sha256 }));
}

async function outputBaseline(task: Task, taskStore: TaskStore, nodeId: string, outputPaths: string[]): Promise<ChangeBaseline['outputs']> {
  if (task.nodes[nodeId] === undefined) {
    throw new TaskRunnerError('ARTIFACT_MISSING', `未知节点：${nodeId}`);
  }
  return Promise.all(outputPaths.map(async (path) => {
    const hash = await fileHash(taskStore.taskDirectory(task.id), path);
    return { path, ...(hash.sha256 === undefined ? {} : { sha256: hash.sha256 }) };
  }));
}

function validateArtifactContent(task: Task, nodeId: string, path: string, content: string, evidencePaths: string[]): void {
  const node = task.nodes[nodeId];
  if (node === undefined) {
    throw new TaskRunnerError('ARTIFACT_MISSING', `未知节点：${nodeId}`);
  }
  if (path === handoffPath(nodeId, node.revision + 1)) {
    try {
      validateHandoff(content, { taskId: task.id, nodeId, phase: node.phase, revision: node.revision + 1, evidencePaths });
      return;
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', error instanceof Error ? error.message : '交接包无效');
    }
  }
  if (path === 'artifacts/work-breakdown.yaml') {
    try {
      validateWorkBreakdown(content);
      return;
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', error instanceof ImplementationWorkPlannerError ? error.message : '实施工作单元声明无效');
    }
  }
  if (path === 'artifacts/decision-register.yaml') {
    try {
      DecisionRegisterSchema.parse(parse(content));
      return;
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', formatSchemaDiagnostics({
        title: '决策登记',
        error,
        aliases: {
          acceptanceIds: '不能使用 acceptanceIds；请改为 affects.acceptanceRefs。',
          acceptanceId: '不能使用 acceptanceId；请改为 affects.acceptanceRefs。',
          workUnitIds: '不能使用 workUnitIds；请改为 affects.workUnits。',
          status: '不能在 option 中使用 status；请改为 effect。',
          recommendationId: '不能使用 recommendationId；请改为 recommendation.optionId。',
        },
        itemLabel: '决策项',
      }));
    }
  }
  if (path === 'artifacts/acceptance.yaml') {
    try {
      AcceptanceCatalogSchema.parse(parse(content));
      return;
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', formatSchemaDiagnostics({
        title: '验收清单',
        error,
        aliases: {
          acceptanceId: '不能使用 acceptanceId；请改为 id。',
          name: '不能使用 name；请改为 title。',
          criteria: '不能使用 criteria；请改为 description。',
        },
        itemLabel: '验收项',
      }));
    }
  }
  if (path === 'artifacts/acceptance-results.yaml') {
    try {
      AcceptanceResultsSchema.parse(parse(content));
      return;
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', formatSchemaDiagnostics({
        title: '验收结果',
        error,
        aliases: {
          acceptanceId: '不能使用 acceptanceId；请改为 id。',
          result: '不能使用 result；请改为 status。',
          proofs: '不能使用 proofs；请改为 evidence。',
        },
        itemLabel: '验收结果',
      }));
    }
  }
  if (path === 'artifacts/implementation-context.md' && Buffer.byteLength(content, 'utf8') > 16_000) {
    throw new TaskRunnerError('ARTIFACT_INVALID', '实施上下文摘要超过 4000 tokens 预算，必须压缩后重新生成计划');
  }
  if (content.trim().length < 24) {
    throw new TaskRunnerError('ARTIFACT_INVALID', `节点产物内容不足：${path}`);
  }
  try {
    validateMarkdownArtifactContract(path, content);
  } catch (error) {
    throw new TaskRunnerError('ARTIFACT_INVALID', error instanceof Error ? error.message : `${path} 结构无效`);
  }
  if (node.phase === 'test' && !hasTestExecutionEvidence(content)) {
    throw new TaskRunnerError('ARTIFACT_INVALID', '测试报告必须包含测试命令与测试结果');
  }
}

async function validateArtifactSet(task: Task, taskStore: TaskStore, nodeId: string, contents: Map<string, string>): Promise<void> {
  const node = task.nodes[nodeId];
  if (node === undefined) return;
  if (node.phase === 'clarify') {
    const catalogContent = contents.get('artifacts/acceptance.yaml');
    const registerContent = contents.get('artifacts/decision-register.yaml');
    if (catalogContent === undefined || registerContent === undefined) return;
    const catalog = AcceptanceCatalogSchema.parse(parse(catalogContent));
    const register = DecisionRegisterSchema.parse(parse(registerContent));
    validateClarifyDecisionChoices(register);
    const acceptanceIds = new Set(catalog.items.map((item) => item.id));
    const unknown = register.items.flatMap((item) => item.affects.acceptanceRefs.filter((id) => !acceptanceIds.has(id)).map((id) => `${item.id} → ${id}`));
    if (unknown.length > 0) {
      throw new TaskRunnerError('ARTIFACT_INVALID', `决策登记引用了验收清单中不存在的验收项：${unknown.join('、')}。请先在 artifacts/acceptance.yaml 声明该 AC，或修正 affects.acceptanceRefs。`);
    }
  }
  if (node.phase === 'test') {
    const resultContent = contents.get('artifacts/acceptance-results.yaml');
    if (resultContent === undefined) return;
    const results = AcceptanceResultsSchema.parse(parse(resultContent));
    const catalogContent = await readFile(join(taskStore.taskDirectory(task.id), 'artifacts', 'acceptance.yaml'), 'utf8');
    const catalog = AcceptanceCatalogSchema.parse(parse(catalogContent));
    const expected = new Set(catalog.items.map((item) => item.id));
    const actual = new Set(results.items.map((item) => item.id));
    const missing = [...expected].filter((id) => !actual.has(id));
    const unknown = [...actual].filter((id) => !expected.has(id));
    if (missing.length > 0 || unknown.length > 0) {
      const parts = [
        ...(missing.length === 0 ? [] : [`缺少结果：${missing.join('、')}`]),
        ...(unknown.length === 0 ? [] : [`不存在的验收项：${unknown.join('、')}`]),
      ];
      throw new TaskRunnerError('ARTIFACT_INVALID', `验收结果必须与验收清单逐项一一对应：${parts.join('；')}。`);
    }
  }
}

/**
 * `task review` has a fixed two-level interaction: first choose whether this
 * item continues in the current scope, then choose one of the AI's business
 * alternatives.  Keep the generated register aligned with that interaction,
 * rather than letting an old-style "wait/defer/waive" option leak into it.
 */
function validateClarifyDecisionChoices(register: import('../domain/decision-register.js').DecisionRegister): void {
  for (const item of register.items) {
    const nonContinuing = item.options.filter((option) => option.effect !== 'resolved');
    if (nonContinuing.length > 0) {
      throw new TaskRunnerError(
        'ARTIFACT_INVALID',
        `决策项 ${item.id} 的 AI 方案只能表示“本期继续”；等待外部条件由 task review 第一层处理。请将 ${nonContinuing.map((option) => option.id).join('、')} 改为可在本期执行的方案，或拆成独立决策项。`,
      );
    }
    const recommended = item.options.find((option) => option.id === item.recommendation.optionId);
    if (recommended?.effect !== 'resolved') {
      throw new TaskRunnerError('ARTIFACT_INVALID', `决策项 ${item.id} 的 AI 推荐必须指向一个“本期继续”方案。`);
    }
  }
}

/**
 * A handoff may cite both:
 *
 * - task facts actually injected into this run; and
 * - immutable task facts available on demand, such as source snapshots,
 *   resolved decision facts, and declared upstream outputs.
 *
 * The second group deliberately stays out of the default prompt to control
 * context size. Project-local `--include` files remain reference-only because
 * they are not immutable task facts.
 */
export function handoffEvidencePaths(task: Task, nodeId: string, manifest: Pick<ContextManifest, 'files'>): string[] {
  const node = task.nodes[nodeId];
  if (node === undefined) return [];
  const upstream = dependencyClosure(task, nodeId).flatMap((dependency) => task.nodes[dependency]?.outputs ?? []);
  return [...new Set([
    ...manifest.files.filter((file) => file.evidenceEligible).map((file) => file.path),
    ...Object.values(task.sources).flatMap((source) => [source.snapshotPath, source.metaPath]),
    ...registeredDecisionFactPaths(task),
    ...upstream,
    ...node.outputs,
  ])];
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
