import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { CodexAdapter } from '../adapters/codex-adapter.js';
import { RunResultSchema, type RunRequest, type RunResult } from '../domain/run.js';
import type { ContextManifest } from '../domain/context.js';
import type { OutputRecord, SkillLock, Task } from '../domain/task.js';
import type { MethodSourceResolverPort } from '../ports/method-source-resolver.js';
import { ContextBuilder } from './context-builder.js';
import { SkillRegistry } from './skill-registry.js';
import { TaskFactGuard } from './task-fact-guard.js';
import { FileTaskRunLock, type TaskRunLock } from './task-run-lock.js';
import { transitionNode } from './task-state-machine.js';
import { TaskStore } from './task-store.js';

export class TaskRunnerError extends Error {
  constructor(readonly code: 'NODE_NOT_RUNNABLE' | 'TASK_BUSY' | 'SKILL_LOCK_INVALID' | 'ARTIFACT_MISSING', message: string) {
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
    if (node === undefined || node.phase === 'intake' || node.status !== 'ready' || node.skill === undefined) {
      throw new TaskRunnerError('NODE_NOT_RUNNABLE', '只能运行已就绪且已锁定技能的节点');
    }

    const skill = await this.loadLockedSkill(node.skill);
    if (!skill.phases.includes(node.phase)) {
      throw new TaskRunnerError('SKILL_LOCK_INVALID', '已锁定技能与当前节点阶段不兼容');
    }
    const methods = await Promise.all(node.skill.methodSources.map((source) => this.deps.methodSourceResolver.readLocked(source)));
    const manifest = await this.deps.contextBuilder.build({ task, nodeId: input.nodeId, includes: input.includes });
    await this.deps.taskFactGuard.assertCommitted({ task, paths: committedPaths(task, this.deps.taskStore, manifest) });

    const runId = this.deps.runIdFactory?.() ?? randomUUID();
    const runDirectory = join(this.deps.runtimeRoot, task.id, runId);
    const contextManifestFactPath = `runs/${runId}/context-manifest.json`;
    await this.deps.taskStore.createFact(task.id, contextManifestFactPath, JSON.stringify(manifest, null, 2) + '\n');
    const request: RunRequest = {
      schemaVersion: 'aiw.run/v1',
      runId,
      task: { id: task.id, nodeId: input.nodeId, nodeRevision: node.revision, projectRoot: task.repository },
      instruction: node.title,
      contextManifestPath: join(this.deps.taskStore.taskDirectory(task.id), contextManifestFactPath),
      runDirectory,
      mode: input.dryRun ? 'dry-run' : 'execute',
      artifacts: node.outputs,
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
    const result = RunResultSchema.parse({ ...(await this.execute(request, startedTask, input.nodeId)), contextManifest: manifest });
    await this.writeResult(task.id, runId, result);
    const next = result.status === 'succeeded'
      ? transitionNode(startedTask, input.nodeId, { type: 'succeed', outputs: result.artifacts })
      : transitionNode(startedTask, input.nodeId, { type: 'fail', message: result.error?.message ?? `运行未完成：${result.status}` });
    await this.deps.taskStore.update(next);
    return result;
  }

  private async execute(request: RunRequest, task: Task, nodeId: string): Promise<RunResult> {
    let result: RunResult;
    try {
      result = await this.deps.adapter.run(request);
    } catch (error) {
      result = failedResult(request, 'CODEX_EXECUTION_ERROR', error instanceof Error ? error.message : 'Codex 调用失败');
    }
    if (result.status !== 'succeeded') {
      return result;
    }
    try {
      return RunResultSchema.parse({ ...result, artifacts: await outputRecords(task, this.deps.taskStore, nodeId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : '节点产物校验失败';
      return failedResult(request, 'ARTIFACT_MISSING', message);
    }
  }

  private async loadLockedSkill(lock: SkillLock) {
    const skill = await this.deps.skillRegistry.find(lock.name, lock.version);
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
    try {
      const content = await readFile(join(taskStore.taskDirectory(task.id), path));
      return { path, sha256: createHash('sha256').update(content).digest('hex') };
    } catch {
      throw new TaskRunnerError('ARTIFACT_MISSING', `节点未生成声明产物：${path}`);
    }
  }));
}

function committedPaths(task: Task, taskStore: TaskStore, manifest: ContextManifest): string[] {
  const taskRoot = relative(task.repository, taskStore.taskDirectory(task.id)).replaceAll('\\', '/');
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
