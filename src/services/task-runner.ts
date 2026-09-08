import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

import type { CodexAdapter } from '../adapters/codex-adapter.js';
import type { ContextManifest } from '../domain/context.js';
import { DecisionRegisterSchema } from '../domain/decision-register.js';
import { validateDevelopmentResult } from '../domain/development-result.js';
import { FactRegisterSchema } from '../domain/fact-register.js';
import { DesignAssetsSchema } from '../domain/design.js';
import { ApiAnalysisSchema, selectedApiDocuments } from '../domain/api-analysis.js';
import { validateMarkdownArtifactContract } from '../domain/artifact-contracts.js';
import { outputContractFor } from '../domain/output-contract.js';
import { RunResultSchema, type RunRequest, type RunResult } from '../domain/run.js';
import type { OutputRecord, SkillLock, Task } from '../domain/task.js';
import type { DeliveryWorkspace, DeliveryWorkspaceManager } from '../ports/delivery-workspace.js';
import type { WorkingTreeStatus } from '../ports/repository-status.js';
import { ContextBuilder } from './context-builder.js';
import { materializeDevelopmentWork, validateDevelopmentPlan } from './implementation-work-planner.js';
import { SkillRegistry } from './skill-registry.js';
import { TaskFactGuard } from './task-fact-guard.js';
import { FileTaskRunLock, type TaskRunLock } from './task-run-lock.js';
import { transitionNode } from './task-state-machine.js';
import { TaskStore } from './task-store.js';
import { SourceIntake } from './source-intake.js';

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
    contextBuilder: ContextBuilder;
    taskFactGuard: TaskFactGuard;
    changeInspector: WorkingTreeStatus;
    adapter: CodexAdapter;
    deliveryWorkspaceManager?: DeliveryWorkspaceManager;
    runtimeRoot: string;
    sourceIntake?: SourceIntake;
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
    let task = await this.deps.taskStore.load(input.taskId);
    const node = task.nodes[input.nodeId];
    if (node?.status === 'running') {
      await this.deps.taskStore.update(transitionNode(task, input.nodeId, { type: 'fail', message: '上次运行异常结束，已恢复为失败状态' }));
      throw new TaskRunnerError('RUN_RECOVERED', '上次运行异常结束，节点已恢复；提交任务事实后可再次执行');
    }
    if (node === undefined || node.skills.length === 0 || !['ready', 'failed', 'completed', 'awaiting_approval', 'invalidated', 'cancelled'].includes(node.status)) {
      throw new TaskRunnerError('NODE_NOT_RUNNABLE', '当前节点不可执行');
    }
    const incomplete = node.dependsOn.filter((id) => task.nodes[id]?.status !== 'completed');
    if (incomplete.length > 0) throw new TaskRunnerError('NODE_NOT_RUNNABLE', `请先完成上游节点：${incomplete.join('、')}`);
    if (node.phase === 'solution' && (task.inputs.apiDocuments.status === 'not-asked' || task.inputs.design.status === 'not-asked')) {
      throw new TaskRunnerError('NODE_NOT_RUNNABLE', `请先执行 aiw task inputs ${task.id} 完成资料选择`);
    }
    if (createsOwnSourceSnapshot(node.phase)) {
      await this.deps.taskFactGuard.assertCommitted({
        task,
        projectRoot: this.deps.taskStore.projectDirectory(),
        paths: [`.aiw/tasks/${task.id}/task.yaml`],
      });
    }

    if (node.phase === 'requirement-analysis' && task.sources.requirements === undefined) {
      try {
        task = await this.snapshotRequirement(task);
      } catch (error) {
        const runId = this.deps.runIdFactory?.() ?? randomUUID();
        const running = transitionNode(task, input.nodeId, { type: 'start', runId });
        await this.deps.taskStore.update(transitionNode(running, input.nodeId, {
          type: 'fail', message: error instanceof Error ? error.message : '无法读取需求文档',
        }));
        throw new TaskRunnerError('NODE_NOT_RUNNABLE', error instanceof Error ? `无法读取需求文档：${error.message}` : '无法读取需求文档');
      }
    }
    if (node.phase === 'api-analysis' && hasMissingApiSnapshot(task)) {
      try {
        task = await this.snapshotApiDocuments(task);
      } catch (error) {
        const runId = this.deps.runIdFactory?.() ?? randomUUID();
        const running = transitionNode(task, input.nodeId, { type: 'start', runId });
        await this.deps.taskStore.update(transitionNode(running, input.nodeId, {
          type: 'fail', message: error instanceof Error ? error.message : '无法读取接口文档',
        }));
        throw new TaskRunnerError('NODE_NOT_RUNNABLE', error instanceof Error ? `无法读取接口文档：${error.message}` : '无法读取接口文档');
      }
    }
    const currentNode = task.nodes[input.nodeId]!;
    const skills = await Promise.all(currentNode.skills.map((lock) => this.loadLockedSkill(lock)));
    if (skills.some((skill) => !skill.phases.includes(currentNode.phase))) throw new TaskRunnerError('SKILL_LOCK_INVALID', '已锁定技能与当前节点阶段不兼容');
    const instruction = instructionFor(task, input.nodeId);
    const runId = this.deps.runIdFactory?.() ?? randomUUID();
    const runDirectory = join(this.deps.runtimeRoot, task.id, runId);
    const manifest = await this.deps.contextBuilder.build({
      task, nodeId: input.nodeId, includes: input.includes, enforceBudget: false,
      budgetInputs: [
        { category: 'node-instruction', label: '节点指令', content: instruction },
        ...skills.map((skill) => ({ category: 'skill' as const, label: `技能：${skill.name}@${skill.version}`, content: skill.body })),
      ],
    });
    await this.assertCommittedInputs(task, manifest);
    if (!input.dryRun) await this.assertBusinessTreeClean();

    const outputPaths = node.outputs;
    const workspace = input.dryRun || this.deps.deliveryWorkspaceManager === undefined ? undefined : await this.deps.deliveryWorkspaceManager.prepare({
      projectRoot: this.deps.taskStore.projectDirectory(), runtimeRoot: this.deps.runtimeRoot, taskId: task.id, nodeId: input.nodeId, runId,
    });
    try {
      return await this.execute({ task, nodeId: input.nodeId, instruction, manifest, skills, runId, runDirectory, outputPaths, workspace, dryRun: input.dryRun });
    } finally {
      await workspace?.dispose();
    }
  }

  private async execute(input: {
    task: Task;
    nodeId: string;
    instruction: string;
    manifest: ContextManifest;
    skills: Awaited<ReturnType<TaskRunner['loadLockedSkill']>>[];
    runId: string;
    runDirectory: string;
    outputPaths: string[];
    workspace?: DeliveryWorkspace;
    dryRun: boolean;
  }): Promise<RunResult> {
    const { task, nodeId, skills, runId, runDirectory, outputPaths, workspace } = input;
    const node = task.nodes[nodeId]!;
    const executionRoot = workspace?.projectRoot ?? this.deps.taskStore.projectDirectory();
    const executionStore = workspace === undefined ? this.deps.taskStore : new TaskStore(executionRoot);
    const outputContract = outputContractFor(runId, outputPaths);
    const request: RunRequest = {
      schemaVersion: 'aiw.run/v5', runId,
      task: { id: task.id, nodeId, phase: node.phase as RunRequest['task']['phase'], projectRoot: executionRoot },
      instruction: input.instruction,
      contextManifestPath: `.aiw/tasks/${task.id}/runs/${runId}/context-manifest.json`,
      runDirectory, mode: input.dryRun ? 'dry-run' : 'execute', artifacts: outputPaths, outputContract,
      context: {
        skills: skills.map((skill) => ({ name: skill.name, version: skill.version, content: skill.body })),
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
      let materializedPlan: Task | undefined;
      let adapterResult: RunResult;
      try {
        adapterResult = await this.deps.adapter.run(request, { signal: controller.signal });
      } catch (error) {
        adapterResult = failedResult(request, node.phase === 'design-slicing' ? 'DESIGN_EXPORT_ERROR' : 'CODEX_EXECUTION_ERROR', error instanceof Error ? error.message : '节点执行失败');
      }
      let finalResult = adapterResult;
      if (adapterResult.status === 'succeeded') {
        try {
          const outputs = await readAndValidateOutputs(executionStore, task, node.phase, outputContract.entries);
          const businessPaths = (await this.deps.changeInspector.changedPaths({ projectRoot: executionRoot })).filter((path) => path !== '.aiw' && !path.startsWith('.aiw/'));
          if (node.phase !== 'development' && businessPaths.length > 0) throw new TaskRunnerError('ARTIFACT_INVALID', `非开发节点不允许修改业务代码：${businessPaths.join(', ')}`);
          const publication = node.phase === 'development' ? await workspace?.publish() : undefined;
          const changedPaths = publication?.changedPaths ?? businessPaths;
          if (node.phase === 'development' && changedPaths.length === 0) {
            throw new TaskRunnerError('ARTIFACT_INVALID', '开发节点未产生任何业务代码变更');
          }
          for (const entry of outputContract.entries) await this.deps.taskStore.replaceFact(task.id, entry.finalPath, outputs.contents.get(entry.finalPath)!);
          for (const asset of outputs.binaryFacts) await this.deps.taskStore.replaceBinaryFact(task.id, asset.path, asset.content);
          const artifacts: OutputRecord[] = [...outputPaths, ...outputs.binaryFacts.map((asset) => asset.path)].map((path) => ({ path }));
          if (node.phase === 'plan') {
            const runningTask = await this.deps.taskStore.load(task.id);
            const completedPlan = transitionNode(runningTask, nodeId, { type: 'succeed', runId, outputs: artifacts });
            materializedPlan = (await materializeDevelopmentWork(completedPlan, this.deps.taskStore)).task;
          }
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
      if (finalResult.status === 'succeeded' && current.nodes[nodeId]?.phase === 'requirement-analysis') {
        const decisionContent = finalResult.artifacts.find((artifact) => artifact.path.endsWith('decision-register.yaml'));
        if (decisionContent === undefined) throw new TaskRunnerError('ARTIFACT_MISSING', '需求分析缺少决策登记');
        const decisions = DecisionRegisterSchema.parse(parse(await readFile(join(this.deps.taskStore.taskDirectory(task.id), decisionContent.path), 'utf8')));
        current.nodes[nodeId]!.requiresApproval = decisions.pendingDecisions.length > 0;
      }
      const next = finalResult.status === 'succeeded'
        ? materializedPlan ?? transitionNode(current, nodeId, { type: 'succeed', runId, outputs: finalResult.artifacts })
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
    const ownsSourceSnapshot = createsOwnSourceSnapshot(task.nodes[manifest.nodeId]?.phase);
    const paths = [...(ownsSourceSnapshot ? [] : [prefix + 'task.yaml']), ...manifest.files
      .filter((file) => !['additional', 'generated'].includes(file.role) && !(ownsSourceSnapshot && file.role === 'source'))
      .map((file) => prefix + file.path)];
    await this.deps.taskFactGuard.assertCommitted({ task, projectRoot: this.deps.taskStore.projectDirectory(), paths });
  }

  private async snapshotRequirement(task: Task): Promise<Task> {
    if (this.deps.sourceIntake === undefined) {
      throw new TaskRunnerError('NODE_NOT_RUNNABLE', '当前环境无法读取需求文档');
    }
    const snapshot = await this.deps.sourceIntake.snapshot({ sourceId: 'requirements', value: task.inputs.requirementUrl, revision: 1 });
    const reference = await this.deps.sourceIntake.writeSnapshot({ snapshot, taskDirectory: this.deps.taskStore.taskDirectory(task.id) });
    const next: Task = { ...task, sources: { ...task.sources, requirements: reference } };
    await this.deps.taskStore.update(next);
    return next;
  }

  private async snapshotApiDocuments(task: Task): Promise<Task> {
    if (this.deps.sourceIntake === undefined) throw new TaskRunnerError('NODE_NOT_RUNNABLE', '当前环境无法读取接口文档');
    if (task.inputs.apiDocuments.status !== 'provided') throw new TaskRunnerError('NODE_NOT_RUNNABLE', '接口节点缺少接口文档 URL');
    const sources = { ...task.sources };
    for (const document of selectedApiDocuments(task.inputs.apiDocuments.urls)) {
      if (sources[document.sourceId] !== undefined) continue;
      const snapshot = await this.deps.sourceIntake.snapshot({ sourceId: document.sourceId, value: document.url, revision: 1 });
      sources[document.sourceId] = await this.deps.sourceIntake.writeSnapshot({ snapshot, taskDirectory: this.deps.taskStore.taskDirectory(task.id) });
    }
    const next: Task = { ...task, sources };
    await this.deps.taskStore.update(next);
    return next;
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

async function readAndValidateOutputs(store: TaskStore, task: Task, phase: Task['nodes'][string]['phase'], entries: Array<{ finalPath: string; stagingPath: string }>): Promise<{ contents: Map<string, string>; binaryFacts: Array<{ path: string; content: Buffer }> }> {
  const contents = new Map<string, string>();
  for (const entry of entries) {
    let content: string;
    try { content = await readFile(join(store.taskDirectory(task.id), entry.stagingPath), 'utf8'); }
    catch { throw new TaskRunnerError('ARTIFACT_MISSING', `节点未生成声明产物：${entry.finalPath}`); }
    if (content.trim().length < 10) throw new TaskRunnerError('ARTIFACT_INVALID', `节点产物内容不足：${entry.finalPath}`);
    validateOutput(entry.finalPath, phase, content);
    contents.set(entry.finalPath, content);
  }
  if (phase === 'api-analysis') validateApiAnalysis(task, contents);
  const binaryFacts = phase === 'design-slicing' ? await validateDesignAnalysis(store, task.id, contents) : [];
  return { contents, binaryFacts };
}

function validateApiAnalysis(task: Task, contents: Map<string, string>): void {
  if (task.inputs.apiDocuments.status !== 'provided') throw new TaskRunnerError('ARTIFACT_INVALID', '接口分析不应在未提供接口文档时执行');
  const content = [...contents].find(([path]) => path.endsWith('api-analysis.yaml'))?.[1];
  if (content === undefined) throw new TaskRunnerError('ARTIFACT_MISSING', '接口分析缺少声明产物');
  const analysis = ApiAnalysisSchema.parse(parse(content));
  const expected = selectedApiDocuments(task.inputs.apiDocuments.urls).map((document) => {
    const source = task.sources[document.sourceId];
    if (source === undefined) throw new TaskRunnerError('ARTIFACT_INVALID', `接口文档快照不存在：${document.id}`);
    return { id: document.id, url: document.url, snapshotPath: source.snapshotPath };
  });
  if (analysis.documents.length !== expected.length) throw new TaskRunnerError('ARTIFACT_INVALID', '接口分析必须覆盖所有已提供的接口文档');
  for (const document of expected) {
    const actual = analysis.documents.find((item) => item.id === document.id);
    if (actual === undefined || actual.url !== document.url || actual.snapshotPath !== document.snapshotPath) {
      throw new TaskRunnerError('ARTIFACT_INVALID', `接口分析来源索引不匹配：${document.id}`);
    }
  }
}

async function validateDesignAnalysis(store: TaskStore, taskId: string, contents: Map<string, string>): Promise<Array<{ path: string; content: Buffer }>> {
  const assetsContent = [...contents].find(([path]) => path.endsWith('design-assets.yaml'))?.[1];
  if (assetsContent === undefined) return [];
  const design = DesignAssetsSchema.parse(parse(assetsContent));
  return Promise.all(design.assets.map(async (asset) => {
    let content: Buffer;
    try { content = await readFile(join(store.taskDirectory(taskId), asset.imagePath)); }
    catch { throw new TaskRunnerError('ARTIFACT_MISSING', `设计截图不存在：${asset.imagePath}`); }
    if (!isSupportedDesignImage(content, asset.imagePath)) throw new TaskRunnerError('ARTIFACT_INVALID', `设计截图格式无效：${asset.imagePath}`);
    return { path: asset.imagePath, content };
  }));
}

function isSupportedDesignImage(content: Buffer, path: string): boolean {
  if (path.toLowerCase().endsWith('.png')) return content.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  return content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
}

function validateOutput(path: string, phase: Task['nodes'][string]['phase'], content: string): void {
  try {
    if (path.endsWith('design-assets.yaml')) DesignAssetsSchema.parse(parse(content));
    else if (path.endsWith('api-analysis.yaml')) ApiAnalysisSchema.parse(parse(content));
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
  if (node.phase === 'api-analysis') {
    if (task.inputs.apiDocuments.status !== 'provided') throw new TaskRunnerError('NODE_NOT_RUNNABLE', '接口节点缺少接口文档 URL');
    const index = selectedApiDocuments(task.inputs.apiDocuments.urls).map((document) => {
      const source = task.sources[document.sourceId];
      if (source === undefined) throw new TaskRunnerError('NODE_NOT_RUNNABLE', `接口节点缺少接口快照：${document.id}`);
      return `- ID：${document.id}\n  URL：${document.url}\n  快照：${source.snapshotPath}`;
    }).join('\n');
    return `${node.title}\n只分析下列接口文档快照：\n${index}`;
  }
  if (node.phase !== 'design-slicing') return node.title;
  if (task.inputs.design.status !== 'provided') throw new TaskRunnerError('NODE_NOT_RUNNABLE', '设计节点缺少本地设计图片');
  return `${node.title}\n输入图片：1 张\n裁切原图并记录图片索引与裁切位置，不分析设计，不绑定开发单元。`;
}

function hasMissingApiSnapshot(task: Task): boolean {
  return task.inputs.apiDocuments.status === 'provided'
    && selectedApiDocuments(task.inputs.apiDocuments.urls).some((document) => task.sources[document.sourceId] === undefined);
}

function createsOwnSourceSnapshot(phase: Task['nodes'][string]['phase'] | undefined): boolean {
  return phase === 'requirement-analysis' || phase === 'api-analysis';
}

interface ActiveRun { taskId: string; nodeId: string; runId: string; runDirectory: string; controller: AbortController }
