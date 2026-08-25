import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

import type { CodexAdapter } from '../adapters/codex-adapter.js';
import type { ContextManifest } from '../domain/context.js';
import { DecisionRegisterSchema } from '../domain/decision-register.js';
import { validateDevelopmentResult } from '../domain/development-result.js';
import { FactRegisterSchema } from '../domain/fact-register.js';
import { DesignCatalogSchema, DesignRulesSchema } from '../domain/design.js';
import { validateMarkdownArtifactContract } from '../domain/artifact-contracts.js';
import { outputContractFor } from '../domain/output-contract.js';
import { RunResultSchema, type RunRequest, type RunResult } from '../domain/run.js';
import type { OutputRecord, SkillLock, Task } from '../domain/task.js';
import type { DeliveryWorkspace, DeliveryWorkspaceManager } from '../ports/delivery-workspace.js';
import type { MethodSourceResolverPort } from '../ports/method-source-resolver.js';
import type { WorkingTreeStatus } from '../ports/repository-status.js';
import { ContextBuilder } from './context-builder.js';
import { validateDevelopmentPlan } from './implementation-work-planner.js';
import { SkillRegistry } from './skill-registry.js';
import { TaskFactGuard } from './task-fact-guard.js';
import { FileTaskRunLock, type TaskRunLock } from './task-run-lock.js';
import { transitionNode } from './task-state-machine.js';
import { TaskStore } from './task-store.js';

export class TaskRunnerError extends Error {
  constructor(readonly code: 'NODE_NOT_RUNNABLE' | 'TASK_BUSY' | 'SKILL_LOCK_INVALID' | 'ARTIFACT_MISSING' | 'ARTIFACT_INVALID' | 'WORKTREE_DIRTY' | 'RUN_RECOVERED', message: string) {
    super(message);
    this.name = 'TaskRunnerError';
  }
}

export class TaskRunner {
  private readonly runLock: TaskRunLock;
  private activeRun: ActiveRun | undefined;

  constructor(private readonly deps: {
    taskStore: TaskStore;
    skillRegistry: SkillRegistry;
    methodSourceResolver: MethodSourceResolverPort;
    contextBuilder: ContextBuilder;
    taskFactGuard: TaskFactGuard;
    changeInspector: WorkingTreeStatus;
    adapter: CodexAdapter;
    deliveryWorkspaceManager?: DeliveryWorkspaceManager;
    runtimeRoot: string;
    runIdFactory?: () => string;
    runLock?: TaskRunLock;
  }) {
    this.runLock = deps.runLock ?? new FileTaskRunLock(deps.runtimeRoot);
  }

  async run(input: { taskId: string; nodeId: string; dryRun: boolean; includes: string[] }): Promise<RunResult> {
    const lease = await this.runLock.acquire({ taskId: input.taskId });
    if (lease === undefined) throw new TaskRunnerError('TASK_BUSY', '当前任务正在被其他命令修改，请稍后重试');
    try {
      return await this.runLocked(input);
    } finally {
      await lease.release();
    }
  }

  async requestCancellation(input: { taskId: string; nodeId: string; reason: string }): Promise<boolean> {
    const active = this.activeRun;
    if (active === undefined || active.taskId !== input.taskId || active.nodeId !== input.nodeId) return false;
    await mkdir(active.runDirectory, { recursive: true });
    await writeFile(join(active.runDirectory, 'cancel-request.json'), JSON.stringify({ ...input, runId: active.runId, requestedAt: new Date().toISOString() }) + '\n');
    active.controller.abort(input.reason);
    return true;
  }

  private async runLocked(input: { taskId: string; nodeId: string; dryRun: boolean; includes: string[] }): Promise<RunResult> {
    const task = await this.deps.taskStore.load(input.taskId);
    const node = task.nodes[input.nodeId];
    if (node?.status === 'running') {
      await this.deps.taskStore.update(transitionNode(task, input.nodeId, { type: 'fail', message: '上次运行异常结束，已恢复为失败状态' }));
      throw new TaskRunnerError('RUN_RECOVERED', '上次运行异常结束，节点已恢复；提交任务事实后可再次执行');
    }
    if (node === undefined || node.phase === 'intake' || node.skill === undefined || !['ready', 'failed', 'completed', 'awaiting_approval', 'invalidated', 'cancelled'].includes(node.status)) {
      throw new TaskRunnerError('NODE_NOT_RUNNABLE', '当前节点不可执行');
    }
    const incomplete = node.dependsOn.filter((id) => task.nodes[id]?.status !== 'completed');
    if (incomplete.length > 0) throw new TaskRunnerError('NODE_NOT_RUNNABLE', `请先完成上游节点：${incomplete.join('、')}`);

    const skill = await this.loadLockedSkill(node.skill);
    if (!skill.phases.includes(node.phase)) throw new TaskRunnerError('SKILL_LOCK_INVALID', '已锁定技能与当前节点阶段不兼容');
    const methods = await Promise.all(node.skill.methodSources.map((source) => this.deps.methodSourceResolver.readLocked(source)));
    const instruction = instructionFor(task, input.nodeId);
    const runId = this.deps.runIdFactory?.() ?? randomUUID();
    const runDirectory = join(this.deps.runtimeRoot, task.id, runId);
    const manifest = await this.deps.contextBuilder.build({
      task, nodeId: input.nodeId, includes: input.includes, enforceBudget: false,
      budgetInputs: [
        { category: 'node-instruction', label: '节点指令', content: instruction },
        { category: 'skill', label: `技能：${skill.name}@${skill.version}`, content: skill.body },
        ...methods.map((method) => ({ category: 'method-source' as const, label: `方法论：${method.source.id}`, content: method.content })),
      ],
    });
    await this.assertCommittedInputs(task, manifest);
    if (!input.dryRun) await this.assertBusinessTreeClean();

    const outputPaths = node.outputs;
    const workspace = input.dryRun || this.deps.deliveryWorkspaceManager === undefined ? undefined : await this.deps.deliveryWorkspaceManager.prepare({
      projectRoot: this.deps.taskStore.projectDirectory(), runtimeRoot: this.deps.runtimeRoot, taskId: task.id, nodeId: input.nodeId, runId,
    });
    try {
      return await this.execute({ task, nodeId: input.nodeId, instruction, manifest, skill, methods, runId, runDirectory, outputPaths, workspace, dryRun: input.dryRun });
    } finally {
      await workspace?.dispose();
    }
  }

  private async execute(input: {
    task: Task;
    nodeId: string;
    instruction: string;
    manifest: ContextManifest;
    skill: Awaited<ReturnType<TaskRunner['loadLockedSkill']>>;
    methods: Awaited<ReturnType<MethodSourceResolverPort['readLocked']>>[];
    runId: string;
    runDirectory: string;
    outputPaths: string[];
    workspace?: DeliveryWorkspace;
    dryRun: boolean;
  }): Promise<RunResult> {
    const { task, nodeId, skill, methods, runId, runDirectory, outputPaths, workspace } = input;
    const node = task.nodes[nodeId]!;
    const executionRoot = workspace?.projectRoot ?? this.deps.taskStore.projectDirectory();
    const executionStore = workspace === undefined ? this.deps.taskStore : new TaskStore(executionRoot);
    const outputContract = outputContractFor(runId, outputPaths);
    const request: RunRequest = {
      schemaVersion: 'aiw.run/v3', runId,
      task: { id: task.id, nodeId, phase: node.phase as RunRequest['task']['phase'], projectRoot: executionRoot },
      instruction: input.instruction,
      contextManifestPath: `.aiw/tasks/${task.id}/runs/${runId}/context-manifest.json`,
      runDirectory, mode: input.dryRun ? 'dry-run' : 'execute', artifacts: outputPaths, outputContract,
      context: {
        skill: { name: skill.name, version: skill.version, content: skill.body },
        methodSources: methods.map((method) => ({ id: method.source.id, content: method.content })),
        files: await loadContextFiles(task, this.deps.taskStore, input.manifest),
        images: input.manifest.images.map((image) => ({
          path: image.path,
          absolutePath: join(this.deps.taskStore.taskDirectory(task.id), image.path),
        })),
      },
    };
    const finalizedManifest = this.deps.contextBuilder.finalizePromptBudget({ manifest: input.manifest, prompt: this.deps.adapter.renderPrompt(request) });
    await this.deps.taskStore.replaceFact(task.id, `runs/${runId}/context-manifest.json`, JSON.stringify(finalizedManifest, null, 2) + '\n');

    if (input.dryRun) {
      const result = RunResultSchema.parse({ ...(await this.deps.adapter.run(request)), contextManifest: finalizedManifest });
      await this.persistResult(task.id, runId, result);
      return result;
    }

    for (const entry of outputContract.entries) await mkdir(dirname(join(executionStore.taskDirectory(task.id), entry.stagingPath)), { recursive: true });
    const startedTask = transitionNode(task, nodeId, { type: 'start', runId });
    await this.deps.taskStore.update(startedTask);
    const controller = new AbortController();
    const active: ActiveRun = { taskId: task.id, nodeId, runId, runDirectory, controller };
    this.activeRun = active;
    try {
      let adapterResult: RunResult;
      try {
        adapterResult = await this.deps.adapter.run(request, { signal: controller.signal });
      } catch (error) {
        adapterResult = failedResult(request, 'CODEX_EXECUTION_ERROR', error instanceof Error ? error.message : 'Codex 调用失败');
      }
      let finalResult = adapterResult;
      if (adapterResult.status === 'succeeded') {
        try {
          const contents = await readAndValidateOutputs(executionStore, task.id, node.phase, outputContract.entries);
          const businessPaths = (await this.deps.changeInspector.changedPaths({ projectRoot: executionRoot })).filter((path) => path !== '.aiw' && !path.startsWith('.aiw/'));
          if (node.phase !== 'development' && businessPaths.length > 0) throw new TaskRunnerError('ARTIFACT_INVALID', `非开发节点不允许修改业务代码：${businessPaths.join(', ')}`);
          const publication = node.phase === 'development' ? await workspace?.publish() : undefined;
          const changedPaths = publication?.changedPaths ?? businessPaths;
          if (node.phase === 'development' && changedPaths.length === 0) {
            throw new TaskRunnerError('ARTIFACT_INVALID', '开发节点未产生任何业务代码变更');
          }
          for (const entry of outputContract.entries) await this.deps.taskStore.replaceFact(task.id, entry.finalPath, contents.get(entry.finalPath)!);
          const artifacts: OutputRecord[] = outputPaths.map((path) => ({ path }));
          await this.deps.taskStore.replaceFact(task.id, `runs/${runId}/change-evidence.json`, JSON.stringify({
            schemaVersion: 'aiw.change-evidence/v1', nodeId, runId, changedPaths,
          }, null, 2) + '\n');
          finalResult = RunResultSchema.parse({ ...adapterResult, contextManifest: finalizedManifest, artifacts });
        } catch (error) {
          await workspace?.rollback().catch(() => undefined);
          finalResult = failedResult(request, error instanceof TaskRunnerError ? error.code : 'ARTIFACT_INVALID', error instanceof Error ? error.message : '节点产物无效');
        }
      }
      await this.persistResult(task.id, runId, finalResult);
      const current = await this.deps.taskStore.load(task.id);
      const next = finalResult.status === 'succeeded'
        ? transitionNode(current, nodeId, { type: 'succeed', runId, outputs: finalResult.artifacts })
        : finalResult.status === 'cancelled'
          ? transitionNode(current, nodeId, { type: 'cancel', note: finalResult.error?.message ?? '运行已取消' })
          : transitionNode(current, nodeId, { type: 'fail', message: finalResult.error?.message ?? '运行失败' });
      await this.deps.taskStore.update(next);
      return finalResult;
    } finally {
      if (this.activeRun === active) this.activeRun = undefined;
    }
  }

  private async loadLockedSkill(lock: SkillLock) {
    const skill = await this.deps.skillRegistry.findLocked(lock);
    if (skill === undefined) throw new TaskRunnerError('SKILL_LOCK_INVALID', '已锁定技能在本地注册表中不存在或内容已变化');
    return skill;
  }

  private async assertCommittedInputs(task: Task, manifest: ContextManifest): Promise<void> {
    const prefix = `.aiw/tasks/${task.id}/`;
    const paths = [prefix + 'task.yaml', ...manifest.files.filter((file) => !['additional', 'generated'].includes(file.role)).map((file) => prefix + file.path)];
    await this.deps.taskFactGuard.assertCommitted({ task, projectRoot: this.deps.taskStore.projectDirectory(), paths });
  }

  private async assertBusinessTreeClean(): Promise<void> {
    const changed = (await this.deps.changeInspector.changedPaths({ projectRoot: this.deps.taskStore.projectDirectory() })).filter((path) => path !== '.aiw' && !path.startsWith('.aiw/'));
    if (changed.length > 0) throw new TaskRunnerError('WORKTREE_DIRTY', `业务仓库存在未提交变更：${changed.join(', ')}`);
  }

  private async persistResult(taskId: string, runId: string, result: RunResult): Promise<void> {
    await this.deps.taskStore.replaceFact(taskId, `runs/${runId}/result.json`, JSON.stringify(result, null, 2) + '\n');
  }
}

async function loadContextFiles(task: Task, store: TaskStore, manifest: ContextManifest): Promise<RunRequest['context']['files']> {
  return Promise.all(manifest.files.map(async (file) => ({
    role: file.role,
    path: file.path,
    content: await readFile(file.role === 'additional' ? join(store.projectDirectory(), file.path) : join(store.taskDirectory(task.id), file.path), 'utf8'),
  })));
}

async function readAndValidateOutputs(store: TaskStore, taskId: string, phase: Task['nodes'][string]['phase'], entries: Array<{ finalPath: string; stagingPath: string }>): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const entry of entries) {
    let content: string;
    try { content = await readFile(join(store.taskDirectory(taskId), entry.stagingPath), 'utf8'); }
    catch { throw new TaskRunnerError('ARTIFACT_MISSING', `节点未生成声明产物：${entry.finalPath}`); }
    if (content.trim().length < 10) throw new TaskRunnerError('ARTIFACT_INVALID', `节点产物内容不足：${entry.finalPath}`);
    validateOutput(entry.finalPath, phase, content);
    contents.set(entry.finalPath, content);
  }
  if (phase === 'design') validateDesignAnalysis(contents);
  return contents;
}

function validateDesignAnalysis(contents: Map<string, string>): void {
  const catalogContent = [...contents].find(([path]) => path.endsWith('design-catalog.yaml'))?.[1];
  const rulesContent = [...contents].find(([path]) => path.endsWith('design-rules.yaml'))?.[1];
  if (catalogContent === undefined || rulesContent === undefined) return;

  const catalog = DesignCatalogSchema.parse(parse(catalogContent));
  if (catalog.analysisStatus === 'blocked') {
    throw new TaskRunnerError('ARTIFACT_INVALID', `设计稿读取受阻：${catalog.blockingReason!}`);
  }

  const concreteItems = catalog.items.filter((item) => item.kind !== 'other');
  if (concreteItems.length === 0) {
    throw new TaskRunnerError('ARTIFACT_INVALID', '设计分析未读取到具体页面、区域、弹窗、组件或状态节点');
  }

  const rules = DesignRulesSchema.parse(parse(rulesContent));
  if (rules.rules.length === 0 || rules.rules.some((rule) => rule.nodeIds.length === 0)) {
    throw new TaskRunnerError('ARTIFACT_INVALID', '设计分析必须包含至少一条有具体 Figma 节点依据的设计规则');
  }
}

function validateOutput(path: string, phase: Task['nodes'][string]['phase'], content: string): void {
  try {
    if (path.endsWith('design-catalog.yaml')) DesignCatalogSchema.parse(parse(content));
    else if (path.endsWith('design-rules.yaml')) DesignRulesSchema.parse(parse(content));
    else if (path.endsWith('fact-register.yaml')) FactRegisterSchema.parse(parse(content));
    else if (path.endsWith('decision-register.yaml')) DecisionRegisterSchema.parse(parse(content));
    else if (path.endsWith('development-plan.yaml')) validateDevelopmentPlan(content);
    else if (phase === 'development') validateDevelopmentResult(content);
    else validateMarkdownArtifactContract(path, content);
  } catch (error) {
    throw new TaskRunnerError('ARTIFACT_INVALID', error instanceof Error ? error.message : `节点产物格式无效：${path}`);
  }
}

function failedResult(request: RunRequest, code: string, message: string): RunResult {
  const now = new Date().toISOString();
  return RunResultSchema.parse({ schemaVersion: 'aiw.run-result/v1', runId: request.runId, status: 'failed', runDirectory: request.runDirectory, startedAt: now, finishedAt: now, artifacts: [], error: { code, message } });
}

function instructionFor(task: Task, nodeId: string): string {
  const node = task.nodes[nodeId];
  if (node === undefined) throw new TaskRunnerError('NODE_NOT_RUNNABLE', `未知节点：${nodeId}`);
  if (node.phase !== 'design') return node.title;
  if (task.designInput === undefined) throw new TaskRunnerError('NODE_NOT_RUNNABLE', '设计分析节点缺少 Figma 设计地址');
  return `${node.title}\nFigma 设计地址：${task.designInput.url}\n根节点 ID：${task.designInput.nodeId}`;
}

interface ActiveRun { taskId: string; nodeId: string; runId: string; runDirectory: string; controller: AbortController }
