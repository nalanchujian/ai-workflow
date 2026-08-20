import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { CodexAdapter } from '../adapters/codex-adapter.js';
import { RunResultSchema, type RunRequest, type RunResult } from '../domain/run.js';
import type { ContextManifest } from '../domain/context.js';
import { registeredDecisionFactPaths, type OutputRecord, type SkillLock, type Task } from '../domain/task.js';
import { declaredOutputPath, handoffPath, HandoffSchema, nextArtifactPath, outputPathsForCompletedRun, outputPathsForNextRun, validateHandoff, validateHandoffFactReferences } from '../domain/handoff.js';
import { hasTestPlanEvidence, validateAcceptanceTestEvidence } from '../domain/test-report.js';
import { AcceptanceResultsSchema } from '../domain/acceptance-results.js';
import { AcceptanceIntentSchema } from '../domain/acceptance-intent.js';
import { TestResultsSchema, type TestResults } from '../domain/test-results.js';
import { AcceptanceCatalogSchema } from '../domain/acceptance-catalog.js';
import { DecisionRegisterSchema } from '../domain/decision-register.js';
import { FactRegisterSchema } from '../domain/fact-register.js';
import { codexOutputEntries, outputContractFor, type OutputContract } from '../domain/output-contract.js';
import { formatSchemaDiagnostics } from '../domain/schema-diagnostics.js';
import { validateMarkdownArtifactContract } from '../domain/artifact-contracts.js';
import { parse } from 'yaml';
import type { MethodSourceResolverPort } from '../ports/method-source-resolver.js';
import type { DeliveryWorkspace, DeliveryWorkspaceManager, DeliveryWorkspacePublishResult } from '../ports/delivery-workspace.js';
import type { WorkingTreeStatus } from '../ports/repository-status.js';
import { ContextBuilder } from './context-builder.js';
import { ImplementationWorkPlannerError, WorkBreakdownSchema, validateWorkBreakdown } from './implementation-work-planner.js';
import { SkillRegistry } from './skill-registry.js';
import { SourceSnapshotIntegrity, SourceSnapshotIntegrityError } from './source-snapshot-integrity.js';
import { TaskFactGuard } from './task-fact-guard.js';
import { FileTaskRunLock, type TaskRunLock } from './task-run-lock.js';
import { invalidateNodeAndDependents, transitionNode } from './task-state-machine.js';
import { TaskStore } from './task-store.js';
import { loadRunCompletionBundle } from './run-completion-bundle.js';
import { TaskImpactError, readClarificationImpactArtifacts, readCurrentImpactGraph, validateClarificationImpactArtifacts } from './task-impact-service.js';
import { DeliveryTestExecutor, deliveryTestPlan } from './delivery-test-executor.js';
import { WorkflowPathService } from './workflow-path-service.js';
import { evaluateDeliveryAcceptance, parseAcceptanceIntent, serializeAcceptanceResults } from './delivery-acceptance-evaluator.js';
import { ProjectTestProfiles } from './project-test-profiles.js';

export class TaskRunnerError extends Error {
  constructor(readonly code: 'NODE_NOT_RUNNABLE' | 'TASK_BUSY' | 'SKILL_LOCK_INVALID' | 'SOURCE_INTEGRITY_INVALID' | 'ARTIFACT_MISSING' | 'ARTIFACT_INVALID' | 'ARTIFACT_STALE' | 'WORKTREE_DIRTY' | 'RUN_RECOVERED', message: string) {
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
    deliveryTestExecutor?: DeliveryTestExecutor;
    projectTestProfiles?: ProjectTestProfiles;
    workflowPathService?: WorkflowPathService;
    deliveryWorkspaceManager?: DeliveryWorkspaceManager;
    runtimeRoot: string;
    runIdFactory?: () => string;
    runLock?: TaskRunLock;
  }) {
    this.runLock = deps.runLock ?? new FileTaskRunLock(deps.runtimeRoot);
  }

  async run(input: { taskId: string; nodeId: string; dryRun: boolean; includes: string[] }): Promise<RunResult> {
    const lease = await this.runLock.acquire({ taskId: input.taskId });
    if (lease === undefined) {
      throw new TaskRunnerError('TASK_BUSY', '当前任务正在被其他命令修改，请等待当前操作结束后重试');
    }
    try {
      return await this.runLocked(input);
    } finally {
      await lease.release();
    }
  }

  /**
   * Called by the CLI's SIGINT/SIGTERM handler. The signal is converted into a
   * durable cancellation request before the child is terminated, so a task is
   * never left indefinitely in `running` merely because the terminal closed.
   */
  async requestCancellation(input: { taskId: string; nodeId: string; reason: string }): Promise<boolean> {
    const active = this.activeRun;
    if (active === undefined || active.taskId !== input.taskId || active.nodeId !== input.nodeId) return false;
    await mkdir(active.runDirectory, { recursive: true });
    await writeFile(join(active.runDirectory, 'cancel-request.json'), JSON.stringify({
      taskId: input.taskId,
      nodeId: input.nodeId,
      runId: active.runId,
      requestedAt: new Date().toISOString(),
      note: input.reason,
    }) + '\n', 'utf8');
    active.controller.abort(input.reason);
    return true;
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
    if (node.status === 'invalidated') {
      const incomplete = node.dependsOn.filter((dependency) => task.nodes[dependency]?.status !== 'completed');
      if (incomplete.length > 0) {
        throw new TaskRunnerError('NODE_NOT_RUNNABLE', `当前节点已失效，必须先重新完成上游节点：${incomplete.join('、')}`);
      }
    }

    await this.assertSourceIntegrity(task);
    // A clarification rerun is the recovery path when its assessment is no
    // longer trustworthy. Every downstream node must use a valid selection.
    if (input.nodeId !== 'clarify') {
      await (this.deps.workflowPathService ?? new WorkflowPathService(this.deps.taskStore)).validateSelection(task);
    }
    await this.assertUpstreamIntegrity(task, input.nodeId);
    await this.assertDeliveryUnitImpact(task, input.nodeId);
    const skill = await this.loadLockedSkill(node.skill);
    if (!skill.phases.includes(node.phase)) {
      throw new TaskRunnerError('SKILL_LOCK_INVALID', '已锁定技能与当前节点阶段不兼容');
    }
    const methods = await Promise.all(node.skill.methodSources.map((source) => this.deps.methodSourceResolver.readLocked(source)));
    const testProfiles = input.nodeId === 'plan'
      ? await (this.deps.projectTestProfiles ?? new ProjectTestProfiles()).list(this.deps.taskStore.projectDirectory())
      : [];
    if (input.nodeId === 'plan' && testProfiles.length === 0) {
      throw new TaskRunnerError(
        'ARTIFACT_INVALID',
        '项目尚未发现可用测试能力。请在 .aiw/config.yaml 的 testing.profiles 中配置受支持的测试命令与健康检查后，再生成实施计划。',
      );
    }
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
    const deliveryWorkspace = input.dryRun || !isDeliveryUnit(node) || this.deps.deliveryWorkspaceManager === undefined
      ? undefined
      : await this.deps.deliveryWorkspaceManager.prepare({
        projectRoot: this.deps.taskStore.projectDirectory(),
        runtimeRoot: this.deps.runtimeRoot,
        taskId: task.id,
        nodeId: input.nodeId,
        runId,
      });
    try {
      return await this.runPrepared({
        input,
        task,
        node,
        skill,
        methods,
        testProfiles,
        outputPaths,
        manifest,
        runId,
        runDirectory,
        deliveryWorkspace,
      });
    } finally {
      await deliveryWorkspace?.dispose();
    }
  }

  private async runPrepared(input: {
    input: { taskId: string; nodeId: string; dryRun: boolean; includes: string[] };
    task: Task;
    node: Task['nodes'][string];
    skill: Awaited<ReturnType<TaskRunner['loadLockedSkill']>>;
    methods: Awaited<ReturnType<MethodSourceResolverPort['readLocked']>>[];
    testProfiles: Awaited<ReturnType<ProjectTestProfiles['list']>>;
    outputPaths: string[];
    manifest: ContextManifest;
    runId: string;
    runDirectory: string;
    deliveryWorkspace?: DeliveryWorkspace;
  }): Promise<RunResult> {
    const { task, node, skill, methods, testProfiles, outputPaths, manifest, runId, runDirectory, deliveryWorkspace } = input;
    const executionProjectRoot = deliveryWorkspace?.projectRoot ?? this.deps.taskStore.projectDirectory();
    const executionTaskStore = deliveryWorkspace === undefined ? this.deps.taskStore : new TaskStore(executionProjectRoot);
    const outputContract = outputContractFor(runId, outputPaths);
    const scope = input.input.dryRun ? undefined : await this.taskFactWriteScope(task, input.input.nodeId, runId, outputContract);
    const contextManifestFactPath = `runs/${runId}/context-manifest.json`;
    const request: RunRequest = {
      schemaVersion: 'aiw.run/v2',
      runId,
      task: {
        id: task.id,
        nodeId: input.input.nodeId,
        phase: node.phase as RunRequest['task']['phase'],
        ...(task.workflowPath === undefined ? {} : { workflowPath: task.workflowPath.id }),
        projectRoot: executionProjectRoot,
        testPlan: isDeliveryUnit(node) ? deliveryTestPlan(node) : [],
        testProfiles: testProfiles.map((profile) => ({
          id: profile.id,
          title: profile.title,
          targetMode: profile.targetMode,
          evidenceTypes: profile.evidenceTypes,
        })),
      },
      instruction: node.title,
      contextManifestPath: join(this.deps.taskStore.taskDirectory(task.id), contextManifestFactPath),
      runDirectory,
      mode: input.input.dryRun ? 'dry-run' : 'execute',
      artifacts: outputPaths,
      outputContract,
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
    const baseline: ChangeBaseline = {
      path: `runs/${runId}/change-baseline.json`,
      changedPaths: [],
      outputs: input.input.dryRun ? [] : await outputBaseline(task, this.deps.taskStore, input.input.nodeId, outputPaths),
      ...(input.input.dryRun ? {} : { git: await this.deps.changeInspector.revision({ projectRoot: executionProjectRoot }) }),
    };
    if (!input.input.dryRun) {
      await this.deps.taskStore.createFact(task.id, baseline.path, JSON.stringify({
        schemaVersion: 'aiw.change-baseline/v1', taskId: task.id, nodeId: input.input.nodeId, runId, capturedAt: new Date().toISOString(), changedPaths: baseline.changedPaths, outputs: baseline.outputs, ...(baseline.git === undefined ? {} : { git: baseline.git }),
      }, null, 2) + '\n');
    }

    if (input.input.dryRun) {
      const result = RunResultSchema.parse({ ...(await this.deps.adapter.run(request)), contextManifest: finalizedManifest });
      await this.writeResult(task.id, runId, result);
      return result;
    }

    const startedTask = transitionNode(task, input.input.nodeId, { type: 'start', runId });
    await this.deps.taskStore.update(startedTask);
    const controller = new AbortController();
    const activeRun: ActiveRun = { taskId: task.id, nodeId: input.input.nodeId, runId, runDirectory, controller };
    this.activeRun = activeRun;
    try {
      if (scope === undefined) throw new TaskRunnerError('NODE_NOT_RUNNABLE', '执行节点缺少任务事实写入边界');
      await prepareOutputStaging(executionTaskStore, task.id, outputContract);
      await this.deps.taskStore.createFact(task.id, `runs/${runId}/change-scope.json`, JSON.stringify(scope, null, 2) + '\n');
      const agentFactBaselinePath = `runs/${runId}/agent-task-fact-baseline.json`;
      const recordedAgentFactBaseline = await snapshotAiWorkflowFacts(executionProjectRoot);
      await this.deps.taskStore.createFact(task.id, agentFactBaselinePath, JSON.stringify({
        schemaVersion: 'aiw.agent-task-fact-baseline/v1',
        taskId: task.id,
        nodeId: input.input.nodeId,
        runId,
        capturedAt: new Date().toISOString(),
        facts: recordedAgentFactBaseline,
      }, null, 2) + '\n');
      const protectedTaskFacts = await snapshotAiWorkflowFactsWithContents(executionProjectRoot);
      const result = RunResultSchema.parse({
        ...(await this.execute(
          request,
          startedTask,
          input.input.nodeId,
          scope,
          baseline,
          finalizedManifest,
          protectedTaskFacts,
          controller.signal,
          { projectRoot: executionProjectRoot, taskStore: executionTaskStore, deliveryWorkspace },
        )),
        contextManifest: finalizedManifest,
      });
      await this.writeResult(task.id, runId, result);
      const next = result.status === 'succeeded'
        ? transitionNode(startedTask, input.input.nodeId, { type: 'succeed', runId, outputs: result.artifacts, evidencePath: `runs/${runId}/change-evidence.json` })
        : result.status === 'cancelled'
          ? transitionNode(startedTask, input.input.nodeId, { type: 'cancel', note: result.error?.message ?? '已取消当前运行' })
          : transitionNode(startedTask, input.input.nodeId, { type: 'fail', message: result.error?.message ?? `运行未完成：${result.status}` });
      await this.deps.taskStore.update(next);
      return result;
    } catch (error) {
      try {
        await deliveryWorkspace?.rollback();
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : '业务补丁自动回滚失败';
        throw new TaskRunnerError('ARTIFACT_INVALID', `${error instanceof Error ? error.message : '交付单元收尾失败'}；${message}`);
      }
      throw error;
    } finally {
      if (this.activeRun === activeRun) this.activeRun = undefined;
    }
  }

  private async execute(
    request: RunRequest,
    task: Task,
    nodeId: string,
    scope: TaskFactWriteScope,
    baseline: ChangeBaseline,
    manifest: ContextManifest,
    protectedTaskFacts: TaskFactSnapshotWithContents,
    signal: AbortSignal,
    execution: RunExecutionWorkspace,
  ): Promise<RunResult> {
    if (signal.aborted || await cancellationRequested(request.runDirectory)) {
      return cancelledResult(request, '已收到取消请求，未启动 Codex');
    }
    let result: RunResult;
    try {
      result = await this.deps.adapter.run(request, {
        onProcessStarted: async (processId) => {
          await writeFile(join(request.runDirectory, 'process.json'), JSON.stringify({ processId, startedAt: new Date().toISOString() }) + '\n', 'utf8');
        },
        signal,
      });
    } catch (error) {
      result = failedResult(request, 'CODEX_EXECUTION_ERROR', error instanceof Error ? error.message : 'Codex 调用失败');
    }
    if (signal.aborted || await cancellationRequested(request.runDirectory)) {
      result = cancelledResult(request, '已取消当前 Codex 运行');
    }
    const agentTaskFacts = await inspectAgentTaskFactChanges(execution.projectRoot, protectedTaskFacts.hashes, scope);
    if (agentTaskFacts.violations.length > 0) {
      const restoredTaskFactPaths = await restoreTaskFactViolations(
        execution.projectRoot,
        protectedTaskFacts.contents,
        agentTaskFacts.violations,
      );
      const expectedHandoff = request.artifacts.find((path) => path === handoffPath(nodeId));
      const message = `检测到不允许写入的任务事实：${agentTaskFacts.violations.join(', ')}。本次运行只允许通过暂存区发布当前节点产物（${expectedHandoff ?? '当前节点交接包'}）；AIW 已自动还原这些改动。`;
      await this.persistChangeEvidence(task, {
        ...(await this.recordChangeEvidence(task, request, scope, result, baseline, agentTaskFacts, execution, undefined, restoredTaskFactPaths)),
        failure: failureEvidence('task-facts', 'TASK_FACT_WRITE_VIOLATION', message),
      });
      return failedResult(request, 'TASK_FACT_WRITE_VIOLATION', message);
    }
    if (result.status !== 'succeeded') {
      await this.persistChangeEvidence(task, {
        ...(await this.recordChangeEvidence(task, request, scope, result, baseline, agentTaskFacts, execution)),
        failure: failureEvidence(result.status === 'cancelled' ? 'cancelled' : 'adapter', result.error?.code ?? 'CODEX_EXECUTION_ERROR', result.error?.message ?? `运行未完成：${result.status}`),
      });
      return result;
    }
    let evidence: ChangeEvidence | undefined;
    let publication: DeliveryWorkspacePublishResult | undefined;
    let previousFormalOutputs: Map<string, Buffer | undefined> | undefined;
    let formalOutputsPromoted = false;
    try {
      if (isDeliveryUnit(task.nodes[nodeId]!)) {
        if (this.deps.deliveryTestExecutor === undefined) {
          throw new TaskRunnerError('ARTIFACT_INVALID', '当前环境未配置 AIW 测试执行器，无法生成可验证的交付验收证据');
        }
        const tests = await this.deps.deliveryTestExecutor.execute({
          task,
          nodeId,
          node: task.nodes[nodeId]!,
          runId: request.runId,
          taskStore: execution.taskStore,
          projectRoot: execution.projectRoot,
          outputPath: request.outputContract.entries.find((entry) => entry.finalPath.endsWith('/test-results.yaml'))?.stagingPath,
          signal,
        });
        await copyTestEvidence(task.id, tests, execution.taskStore, this.deps.taskStore);
        const intentOutput = request.outputContract.entries.find((entry) => entry.finalPath.endsWith('/acceptance-intent.yaml'));
        const resultOutput = request.outputContract.entries.find((entry) => entry.finalPath.endsWith('/acceptance-results.yaml'));
        if (intentOutput === undefined || resultOutput === undefined) {
          throw new TaskRunnerError('ARTIFACT_INVALID', '交付单元缺少验收意图或平台验收结果产物声明');
        }
        const intentContent = await readFile(join(execution.taskStore.taskDirectory(task.id), intentOutput.stagingPath), 'utf8');
        const acceptance = evaluateDeliveryAcceptance({
          intent: parseAcceptanceIntent(intentContent),
          tests,
          acceptanceRefs: task.nodes[nodeId]!.acceptanceRefs,
          verificationPlan: task.nodes[nodeId]!.verificationPlan,
        });
        await execution.taskStore.createFact(task.id, resultOutput.stagingPath, serializeAcceptanceResults(acceptance));
      }
      if (nodeId === 'plan') {
        const breakdownOutput = request.outputContract.entries.find((entry) => entry.finalPath.endsWith('/work-breakdown.yaml'));
        if (breakdownOutput === undefined) throw new TaskRunnerError('ARTIFACT_INVALID', '计划节点缺少实施工作单元声明');
        const breakdown = WorkBreakdownSchema.parse(parse(await readFile(join(this.deps.taskStore.taskDirectory(task.id), breakdownOutput.stagingPath), 'utf8')));
        await (this.deps.projectTestProfiles ?? new ProjectTestProfiles()).assertHealthy(
          this.deps.taskStore.projectDirectory(),
          breakdown.units.flatMap((unit) => unit.verification),
        );
      }
      if (signal.aborted || await cancellationRequested(request.runDirectory)) {
        const cancelled = cancelledResult(request, '已取消当前运行');
        await this.persistChangeEvidence(task, {
          ...(await this.recordChangeEvidence(task, request, scope, cancelled, baseline, agentTaskFacts, execution)),
          failure: failureEvidence('cancelled', 'RUN_CANCELLED', '已取消当前运行'),
        });
        return cancelled;
      }
      const stagedContents = await readStagedOutputContents(task, execution.taskStore, request.outputContract);
      const artifacts = await outputRecordsFromContents(task, execution.taskStore, nodeId, baseline.outputs, manifest, stagedContents);
      // A staged result is not yet a task fact. Check for forbidden Git
      // history/branch mutation before any promotion so a failed run can
      // never publish output that was produced under an invalid baseline.
      const prePromotionEvidence = await this.recordChangeEvidence(task, request, scope, result, baseline, agentTaskFacts, execution);
      if (prePromotionEvidence.git.historyChanged) {
        const message = '检测到 Codex 修改了 Git 提交或分支，当前运行已停止';
        await this.persistChangeEvidence(task, { ...prePromotionEvidence, failure: failureEvidence('git-history', 'GIT_HISTORY_MUTATION', message) });
        return failedResult(request, 'GIT_HISTORY_MUTATION', message);
      }
      previousFormalOutputs = await snapshotFormalOutputs(this.deps.taskStore, task.id, request.outputContract);
      publication = await execution.deliveryWorkspace?.publish();
      await promoteStagedOutputs(this.deps.taskStore, task.id, request.outputContract, stagedContents);
      formalOutputsPromoted = true;
      evidence = mergeChangeEvidence(
        prePromotionEvidence,
        await this.recordChangeEvidence(task, request, scope, result, baseline, agentTaskFacts, execution),
      );
      await execution.taskStore.removeFacts(task.id, [`runs/${request.runId}/staging`]);
      await this.persistChangeEvidence(task, { ...evidence, artifacts, ...(publication === undefined ? {} : { publication: publicationEvidence(publication) }) });
      return RunResultSchema.parse({ ...result, artifacts });
    } catch (error) {
      let rollbackFailure: string | undefined;
      if (publication?.published === true && execution.deliveryWorkspace !== undefined) {
        try {
          await execution.deliveryWorkspace.rollback();
        } catch (rollbackError) {
          rollbackFailure = rollbackError instanceof Error ? rollbackError.message : '业务补丁自动回滚失败';
        }
      }
      if (formalOutputsPromoted && previousFormalOutputs !== undefined) {
        try {
          await restoreFormalOutputs(this.deps.taskStore, task.id, previousFormalOutputs);
        } catch (restoreError) {
          const detail = restoreError instanceof Error ? restoreError.message : '正式任务产物自动恢复失败';
          rollbackFailure = rollbackFailure === undefined ? detail : `${rollbackFailure}；${detail}`;
        }
      }
      const baseMessage = error instanceof Error ? error.message : '节点产物校验失败';
      const message = rollbackFailure === undefined ? baseMessage : `${baseMessage}；${rollbackFailure}`;
      const code = error instanceof TaskRunnerError ? error.code : 'ARTIFACT_INVALID';
      const captured = evidence ?? await this.recordChangeEvidence(task, request, scope, result, baseline, agentTaskFacts, execution);
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

  private async assertSourceIntegrity(task: Task): Promise<void> {
    try {
      await new SourceSnapshotIntegrity(this.deps.taskStore).assert(task);
    } catch (error) {
      const message = error instanceof SourceSnapshotIntegrityError ? error.message : '需求来源完整性校验失败';
      const sourceId = error instanceof SourceSnapshotIntegrityError ? error.sourceId ?? '<source-id>' : '<source-id>';
      throw new TaskRunnerError(
        'SOURCE_INTEGRITY_INVALID',
        `${message}；请通过 aiw task source refresh ${task.id} ${sourceId} 重新固化需求来源后再运行。`,
      );
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

  /** A generated delivery node is executable only when the approved plan's
   * immutable graph still identifies the exact unit, AC set and decisions it
   * is about to deliver. */
  private async assertDeliveryUnitImpact(task: Task, nodeId: string): Promise<void> {
    const node = task.nodes[nodeId];
    if (node?.phase !== 'implement' || node.generatedFromPlan !== true || node.workUnitId === undefined) return;
    try {
      const graph = await readCurrentImpactGraph(task, this.deps.taskStore);
      const unit = graph?.units.find((item) => item.id === node.workUnitId);
      if (unit === undefined || unit.deliveryNodeId !== nodeId) {
        throw new Error(`交付单元 ${node.workUnitId} 未在当前影响图中登记`);
      }
      if (unit.acceptanceRefs.length !== node.acceptanceRefs.length || unit.acceptanceRefs.some((id) => !node.acceptanceRefs.includes(id))) {
        throw new Error(`交付单元 ${node.workUnitId} 的验收项与当前影响图不一致`);
      }
      if (unit.decisionIds.length !== node.decisionRefs.length || unit.decisionIds.some((id) => !node.decisionRefs.includes(id))) {
        throw new Error(`交付单元 ${node.workUnitId} 的决策引用与当前影响图不一致`);
      }
      if (JSON.stringify(unit.verificationPlan) !== JSON.stringify(node.verificationPlan)) {
        throw new Error(`交付单元 ${node.workUnitId} 的验收测试映射与当前影响图不一致`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : '无法校验影响图';
      throw new TaskRunnerError('ARTIFACT_INVALID', `交付单元影响图无效：${reason}；请重新运行并批准 plan 以生成当前业务单元图。`);
    }
  }

  private async taskFactWriteScope(task: Task, nodeId: string, runId: string, outputContract: OutputContract): Promise<TaskFactWriteScope> {
    const node = task.nodes[nodeId];
    if (node === undefined) {
      throw new TaskRunnerError('NODE_NOT_RUNNABLE', `未知节点：${nodeId}`);
    }
    const taskRoot = relative(this.deps.taskStore.projectDirectory(), this.deps.taskStore.taskDirectory(task.id)).replaceAll('\\', '/');
    const outputPaths = outputPathsForNextRun(nodeId, node);
    const agentWritableTaskPaths = codexOutputEntries(outputContract)
      .map((entry) => `${taskRoot}/${entry.stagingPath}`);
    const platformOwnedTaskPaths = [
      `${taskRoot}/task.yaml`,
      `${taskRoot}/runs/${runId}/**`,
      ...outputPaths.map((path) => `${taskRoot}/${path}`),
    ];
    return {
      schemaVersion: 'aiw.change-scope/v4',
      taskId: task.id,
      nodeId,
      runId,
      businessFilePolicy: 'unrestricted',
      agentWritableTaskPaths,
      platformOwnedTaskPaths,
    };
  }

  private async recordChangeEvidence(task: Task, request: RunRequest, scope: TaskFactWriteScope, result: RunResult, baseline: ChangeBaseline, agentTaskFacts: AgentTaskFactChanges, execution: RunExecutionWorkspace, artifacts?: OutputRecord[], restoredTaskFactPaths?: string[]): Promise<ChangeEvidence> {
    const projectRoot = execution.projectRoot;
    const changedPaths = (await this.deps.changeInspector.changedPaths({ projectRoot }))
      .filter((path) => execution.deliveryWorkspace === undefined || !isExecutionInfrastructurePath(path));
    const taskFactViolations = agentTaskFacts.violations;
    const rawDiff = await this.deps.changeInspector.diff({ projectRoot });
    const untrackedPaths = (await this.deps.changeInspector.untrackedPaths({ projectRoot }))
      .filter((path) => execution.deliveryWorkspace === undefined || !isExecutionInfrastructurePath(path));
    const changedFiles = await Promise.all(changedPaths.map(async (path) => ({ path, ...(await fileHash(projectRoot, path)) })));
    const after = await this.deps.changeInspector.revision({ projectRoot });
    const patch = `${rawDiff}${await untrackedPatch(projectRoot, untrackedPaths)}`;
    const evidence: ChangeEvidence = {
      schemaVersion: 'aiw.change-evidence/v2', taskId: task.id, nodeId: scope.nodeId, runId: request.runId,
      baseline,
      changedPaths, taskFactViolations, agentTaskFacts: agentTaskFacts.changes, changedFiles,
      ...(restoredTaskFactPaths === undefined ? {} : { restoredTaskFactPaths }),
      untrackedPaths,
      git: { before: baseline.git ?? {}, after, historyChanged: !sameGitRevision(baseline.git, after) },
      patch,
      diff: { sha256: createHash('sha256').update(patch).digest('hex'), lineCount: patch === '' ? 0 : patch.split(/\r?\n/).length - 1 },
      ...(result.process === undefined ? {} : { process: result.process }),
      ...(artifacts === undefined ? {} : { artifacts }),
      ...(execution.deliveryWorkspace === undefined ? {} : {
        executionWorkspace: { mode: 'git-worktree' as const, sourceHead: execution.deliveryWorkspace.sourceHead },
      }),
    };
    return evidence;
  }

  private async persistChangeEvidence(task: Task, evidence: ChangeEvidence): Promise<void> {
    const { patch, ...sharedEvidence } = evidence;
    await this.deps.taskStore.createFact(task.id, `runs/${evidence.runId}/change.patch`, patch);
    await this.deps.taskStore.createFact(task.id, `runs/${evidence.runId}/change-diff.json`, JSON.stringify({ schemaVersion: 'aiw.change-diff/v2', taskId: task.id, runId: evidence.runId, changedPaths: evidence.changedPaths, untrackedPaths: evidence.untrackedPaths, taskFactViolations: evidence.taskFactViolations, ...(evidence.restoredTaskFactPaths === undefined ? {} : { restoredTaskFactPaths: evidence.restoredTaskFactPaths }), patchSha256: evidence.diff.sha256 }, null, 2) + '\n');
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
  schemaVersion: 'aiw.change-scope/v4';
  taskId: string;
  nodeId: string;
  runId: string;
  businessFilePolicy: 'unrestricted';
  agentWritableTaskPaths: string[];
  platformOwnedTaskPaths: string[];
}

interface ActiveRun {
  taskId: string;
  nodeId: string;
  runId: string;
  runDirectory: string;
  controller: AbortController;
}

interface RunExecutionWorkspace {
  projectRoot: string;
  taskStore: TaskStore;
  deliveryWorkspace?: DeliveryWorkspace;
}

interface ChangeEvidence {
  schemaVersion: 'aiw.change-evidence/v2';
  taskId: string;
  nodeId: string;
  runId: string;
  baseline: ChangeBaseline;
  changedPaths: string[];
  taskFactViolations: string[];
  agentTaskFacts: TaskFactChange[];
  restoredTaskFactPaths?: string[];
  changedFiles: Array<{ path: string; sha256?: string; deleted?: true }>;
  untrackedPaths: string[];
  git: { before: { head?: string; branch?: string }; after: { head?: string; branch?: string }; historyChanged: boolean };
  patch: string;
  diff: { sha256: string; lineCount: number };
  process?: unknown;
  artifacts?: OutputRecord[];
  executionWorkspace?: { mode: 'git-worktree'; sourceHead: string };
  publication?: { published: boolean; patchSha256: string; changedPaths: string[] };
  failure?: { stage: 'adapter' | 'task-facts' | 'artifact' | 'git-history' | 'cancelled'; code: string; message: string };
}

interface ChangeBaseline {
  path: string;
  changedPaths: string[];
  outputs: Array<{ path: string; sha256?: string }>;
  git?: { head?: string; branch?: string };
}

/**
 * The first snapshot is the agent's final state before publication; the
 * second is the published task state. Keep their union so the shared evidence
 * contains both business-code changes and the newly promoted formal facts.
 */
function mergeChangeEvidence(before: ChangeEvidence, after: ChangeEvidence): ChangeEvidence {
  const byPath = <T extends { path: string }>(items: T[]): T[] => [...new Map(items.map((item) => [item.path, item])).values()];
  return {
    ...after,
    changedPaths: [...new Set([...before.changedPaths, ...after.changedPaths])].sort(),
    taskFactViolations: [...new Set([...before.taskFactViolations, ...after.taskFactViolations])].sort(),
    agentTaskFacts: byPath([...before.agentTaskFacts, ...after.agentTaskFacts]),
    changedFiles: byPath([...before.changedFiles, ...after.changedFiles]),
    untrackedPaths: [...new Set([...before.untrackedPaths, ...after.untrackedPaths])].sort(),
    git: before.git.historyChanged ? before.git : after.git,
  };
}

function publicationEvidence(result: DeliveryWorkspacePublishResult): NonNullable<ChangeEvidence['publication']> {
  return {
    published: result.published,
    patchSha256: result.patchSha256,
    changedPaths: result.changedPaths,
  };
}

function isExecutionInfrastructurePath(path: string): boolean {
  return path === 'node_modules' || path.startsWith('node_modules/');
}

async function copyTestEvidence(taskId: string, tests: TestResults, source: TaskStore, target: TaskStore): Promise<void> {
  if (source.projectDirectory() === target.projectDirectory()) return;
  for (const item of tests.items) {
    const content = await readFile(join(source.taskDirectory(taskId), item.evidencePath), 'utf8');
    const hash = createHash('sha256').update(content).digest('hex');
    if (hash !== item.evidenceSha256) {
      throw new TaskRunnerError('ARTIFACT_INVALID', `测试证据在复制前发生变化：${item.evidencePath}`);
    }
    await target.replaceFact(taskId, item.evidencePath, content);
  }
}

type TaskFactSnapshot = Record<string, string>;

type TaskFactChange = {
  path: string;
  kind: 'created' | 'modified' | 'deleted';
  beforeSha256?: string;
  afterSha256?: string;
};

type AgentTaskFactChanges = {
  changes: TaskFactChange[];
  violations: string[];
};

function matchesAllowedPath(path: string, allowed: string): boolean {
  return allowed.endsWith('/**') ? path.startsWith(allowed.slice(0, -2)) : path === allowed;
}

/**
 * Git status cannot tell whether a task fact was written by AIW during setup
 * or by Codex afterwards.  Snapshot the whole .aiw tree at the handoff point
 * so platform facts (task.yaml, run evidence and canonical test results) are
 * never accidentally granted to the agent as writable paths.
 */
async function snapshotAiWorkflowFacts(projectRoot: string): Promise<TaskFactSnapshot> {
  const snapshot = await snapshotAiWorkflowFactsWithContents(projectRoot);
  return snapshot.hashes;
}

type TaskFactContents = Record<string, Buffer>;

type TaskFactSnapshotWithContents = {
  hashes: TaskFactSnapshot;
  contents: TaskFactContents;
};

async function snapshotAiWorkflowFactsWithContents(projectRoot: string): Promise<TaskFactSnapshotWithContents> {
  const root = join(projectRoot, '.aiw');
  const entries: Array<{ path: string; content: Buffer }> = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    let children: Dirent<string>[];
    try {
      children = await readdir(directory, { withFileTypes: true, encoding: 'utf8' });
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    await Promise.all(children.map(async (child) => {
      const relativePath = `${relativeDirectory}/${child.name}`;
      const absolutePath = join(directory, child.name);
      if (child.isDirectory()) {
        await visit(absolutePath, relativePath);
        return;
      }
      if (!child.isFile()) return;
      entries.push({ path: relativePath, content: await readFile(absolutePath) });
    }));
  }
  await visit(root, '.aiw');
  const sorted = entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    hashes: Object.fromEntries(sorted.map(({ path, content }) => [path, createHash('sha256').update(content).digest('hex')])),
    contents: Object.fromEntries(sorted.map(({ path, content }) => [path, content])),
  };
}

/**
 * Task facts are auditable inputs, not disposable agent scratch files. The
 * write scope detects violations; this companion restore step ensures a
 * detected write cannot silently corrupt an approved current result before users
 * inspect or commit the failure evidence.
 */
async function restoreTaskFactViolations(projectRoot: string, baseline: TaskFactContents, violations: string[]): Promise<string[]> {
  const restored: string[] = [];
  for (const path of violations) {
    if (!path.startsWith('.aiw/')) continue;
    const absolutePath = join(projectRoot, path);
    const original = baseline[path];
    if (original === undefined) {
      try {
        await rm(absolutePath, { force: true });
        restored.push(path);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      continue;
    }
    await mkdir(join(absolutePath, '..'), { recursive: true });
    await writeFile(absolutePath, original);
    restored.push(path);
  }
  return restored;
}

async function inspectAgentTaskFactChanges(projectRoot: string, baseline: TaskFactSnapshot, scope: TaskFactWriteScope): Promise<AgentTaskFactChanges> {
  const after = await snapshotAiWorkflowFacts(projectRoot);
  const paths = [...new Set([...Object.keys(baseline), ...Object.keys(after)])].sort();
  const changes = paths.flatMap((path): TaskFactChange[] => {
    const beforeSha256 = baseline[path];
    const afterSha256 = after[path];
    if (beforeSha256 === afterSha256) return [];
    return [{
      path,
      kind: beforeSha256 === undefined ? 'created' : afterSha256 === undefined ? 'deleted' : 'modified',
      ...(beforeSha256 === undefined ? {} : { beforeSha256 }),
      ...(afterSha256 === undefined ? {} : { afterSha256 }),
    }];
  });
  return {
    changes,
    violations: changes
      .map((change) => change.path)
      .filter((path) => !scope.agentWritableTaskPaths.some((allowed) => matchesAllowedPath(path, allowed))),
  };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
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

async function outputRecordsFromContents(
  task: Task,
  taskStore: TaskStore,
  nodeId: string,
  baseline: ChangeBaseline['outputs'],
  manifest: ContextManifest | undefined,
  contents: Map<string, Buffer>,
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
    const content = contents.get(path);
    if (content === undefined) {
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

async function readStagedOutputContents(task: Task, taskStore: TaskStore, contract: OutputContract): Promise<Map<string, Buffer>> {
  const contents = await Promise.all(contract.entries.map(async (entry) => {
    try {
      return [entry.finalPath, await readFile(join(taskStore.taskDirectory(task.id), entry.stagingPath))] as const;
    } catch {
      throw new TaskRunnerError('ARTIFACT_MISSING', `节点暂存产物缺失：${entry.finalPath}`);
    }
  }));
  return new Map(contents);
}

async function prepareOutputStaging(taskStore: TaskStore, taskId: string, contract: OutputContract): Promise<void> {
  await Promise.all(codexOutputEntries(contract).map(async (entry) => {
    await mkdir(join(taskStore.taskDirectory(taskId), entry.stagingPath, '..'), { recursive: true });
  }));
}

async function promoteStagedOutputs(
  taskStore: TaskStore,
  taskId: string,
  contract: OutputContract,
  contents: Map<string, Buffer>,
): Promise<void> {
  for (const entry of contract.entries) {
    const content = contents.get(entry.finalPath);
    if (content === undefined) {
      throw new TaskRunnerError('ARTIFACT_MISSING', `节点暂存产物缺失：${entry.finalPath}`);
    }
    await taskStore.replaceFact(taskId, entry.finalPath, content.toString('utf8'));
  }
}

async function snapshotFormalOutputs(taskStore: TaskStore, taskId: string, contract: OutputContract): Promise<Map<string, Buffer | undefined>> {
  const snapshot = new Map<string, Buffer | undefined>();
  for (const entry of contract.entries) {
    try {
      snapshot.set(entry.finalPath, await readFile(join(taskStore.taskDirectory(taskId), entry.finalPath)));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      snapshot.set(entry.finalPath, undefined);
    }
  }
  return snapshot;
}

async function restoreFormalOutputs(taskStore: TaskStore, taskId: string, snapshot: Map<string, Buffer | undefined>): Promise<void> {
  for (const [path, content] of snapshot) {
    if (content === undefined) {
      await taskStore.removeFacts(taskId, [path]);
      continue;
    }
    await taskStore.replaceFact(taskId, path, content.toString('utf8'));
  }
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
  if (path === handoffPath(nodeId)) {
    try {
      validateHandoff(content, {
        taskId: task.id,
        nodeId,
        phase: node.phase,
        evidencePaths,
        decisionFactPaths: registeredDecisionFactPaths(task),
      });
      return;
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', error instanceof Error ? error.message : '交接包无效');
    }
  }
  const declaredPath = declaredOutputPath(nodeId, node, path);
  if (declaredPath === undefined) {
    throw new TaskRunnerError('ARTIFACT_INVALID', `节点产物路径与当前节点不一致：${path}`);
  }
  if (declaredPath === 'artifacts/work-breakdown.yaml') {
    try {
      validateWorkBreakdown(content);
      return;
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', error instanceof ImplementationWorkPlannerError ? error.message : '实施工作单元声明无效');
    }
  }
  if (declaredPath === 'artifacts/decision-register.yaml') {
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
  if (declaredPath === 'artifacts/fact-register.yaml') {
    try {
      FactRegisterSchema.parse(parse(content));
      return;
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', formatSchemaDiagnostics({
        title: '事实登记',
        error,
        aliases: {
          status: '不能使用 status；请改为 kind。',
          source: '不能使用 source；请改为 evidence。',
          confidenceLevel: '不能使用 confidenceLevel；请改为 confidence。',
        },
        itemLabel: '事实项',
      }));
    }
  }
  if (declaredPath === 'artifacts/acceptance.yaml') {
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
  if (declaredPath === 'artifacts/acceptance-intent.yaml') {
    try {
      AcceptanceIntentSchema.parse(parse(content));
      return;
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', formatSchemaDiagnostics({
        title: '验收意图',
        error,
        aliases: {
          acceptanceId: '不能使用 acceptanceId；请改为 id。',
          result: '不能使用 result；AIW 会生成最终 status。',
          proofs: '不能使用 proofs；请改为 evidence。',
        },
        itemLabel: '验收意图',
      }));
    }
  }
  if (declaredPath === 'artifacts/acceptance-results.yaml') {
    try {
      AcceptanceResultsSchema.parse(parse(content));
      return;
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', 'AIW 生成的验收结果无效：' + (error instanceof Error ? error.message : '格式错误'));
    }
  }
  if (declaredPath === 'artifacts/test-results.yaml') {
    try {
      TestResultsSchema.parse(parse(content));
      return;
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', formatSchemaDiagnostics({
        title: '测试执行结果',
        error,
        aliases: {
          testId: '不能使用 testId；请改为 id。',
          result: '不能使用 result；请改为 status。',
          exit_code: '不能使用 exit_code；请改为 exitCode。',
        },
        itemLabel: '测试记录',
      }));
    }
  }
  if (content.trim().length < 24) {
    throw new TaskRunnerError('ARTIFACT_INVALID', `节点产物内容不足：${path}`);
  }
  try {
    validateMarkdownArtifactContract(path, content);
  } catch (error) {
    throw new TaskRunnerError('ARTIFACT_INVALID', error instanceof Error ? error.message : `${path} 结构无效`);
  }
  if (isDeliveryUnit(node) && declaredPath === 'artifacts/delivery.md' && !hasTestPlanEvidence(content)) {
    throw new TaskRunnerError('ARTIFACT_INVALID', '交付报告必须在“测试计划”中记录测试 ID 与命令；实际结果由 AIW 执行后写入 test-results.yaml');
  }
}

async function validateArtifactSet(task: Task, taskStore: TaskStore, nodeId: string, contents: Map<string, string>): Promise<void> {
  const node = task.nodes[nodeId];
  if (node === undefined) return;
  const handoffContent = contents.get(handoffPath(nodeId));
  let clarifyFacts: import('../domain/fact-register.js').FactRegister | undefined;
  if (node.phase === 'clarify') {
    const catalogContent = contents.get(nextArtifactPath(nodeId, node, 'artifacts/acceptance.yaml'));
    const registerContent = contents.get(nextArtifactPath(nodeId, node, 'artifacts/decision-register.yaml'));
    const factsContent = contents.get(nextArtifactPath(nodeId, node, 'artifacts/fact-register.yaml'));
    if (catalogContent === undefined || registerContent === undefined || factsContent === undefined) return;
    const catalog = AcceptanceCatalogSchema.parse(parse(catalogContent));
    const register = DecisionRegisterSchema.parse(parse(registerContent));
    const facts = FactRegisterSchema.parse(parse(factsContent));
    clarifyFacts = facts;
    validateClarifyDecisionChoices(register);
    try {
      validateClarificationImpactArtifacts({ task, facts, decisions: register, acceptance: catalog });
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', error instanceof TaskImpactError ? error.message : '事实与影响关系无效');
    }
  }
  if (handoffContent !== undefined) {
    try {
      const facts = clarifyFacts ?? (await readClarificationImpactArtifacts(task, taskStore)).facts;
      // The first validation pass already checked node identity and
      // evidence allowlists. This second pass runs after all sibling outputs
      // exist so it can bind Handoff Fact IDs to the formal register.
      const handoff = HandoffSchema.parse(parse(handoffContent));
      validateHandoffFactReferences(handoff, facts.items.map((fact) => fact.id));
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', error instanceof Error ? error.message : '交接包事实引用无效');
    }
  }
  if (isDeliveryUnit(node)) {
    const intentContent = contents.get(nextArtifactPath(nodeId, node, 'artifacts/acceptance-intent.yaml'));
    const resultContent = contents.get(nextArtifactPath(nodeId, node, 'artifacts/acceptance-results.yaml'));
    const testContent = contents.get(nextArtifactPath(nodeId, node, 'artifacts/test-results.yaml'));
    const deliveryContent = contents.get(nextArtifactPath(nodeId, node, 'artifacts/delivery.md'));
    if (intentContent === undefined || resultContent === undefined || testContent === undefined || deliveryContent === undefined) return;
    const intent = AcceptanceIntentSchema.parse(parse(intentContent));
    const results = AcceptanceResultsSchema.parse(parse(resultContent));
    const tests = TestResultsSchema.parse(parse(testContent));
    const expected = new Set(node.acceptanceRefs);
    const actual = new Set(results.items.map((item) => item.id));
    const missing = [...expected].filter((id) => !actual.has(id));
    const unknown = [...actual].filter((id) => !expected.has(id));
    if (missing.length > 0 || unknown.length > 0) {
      const parts = [
        ...(missing.length === 0 ? [] : [`缺少结果：${missing.join('、')}`]),
        ...(unknown.length === 0 ? [] : [`不存在的验收项：${unknown.join('、')}`]),
      ];
      throw new TaskRunnerError('ARTIFACT_INVALID', `交付单元验收结果必须与其所属验收项逐项一一对应：${parts.join('；')}。`);
    }
    try {
      const expectedResults = evaluateDeliveryAcceptance({ intent, tests, acceptanceRefs: node.acceptanceRefs, verificationPlan: node.verificationPlan });
      if (JSON.stringify(expectedResults) !== JSON.stringify(results)) {
        throw new Error('验收结果必须完全由 AIW 根据验收意图和实际测试记录生成');
      }
      validateAcceptanceTestEvidence({ report: deliveryContent, acceptance: results, tests });
      await assertTestEvidenceIntegrity(task, taskStore, tests);
    } catch (error) {
      throw new TaskRunnerError('ARTIFACT_INVALID', error instanceof Error ? error.message : '验收项未绑定有效测试结果');
    }
  }
}

async function assertTestEvidenceIntegrity(task: Task, taskStore: TaskStore, tests: import('../domain/test-results.js').TestResults): Promise<void> {
  for (const test of tests.items) {
    let content: Buffer;
    try {
      content = await readFile(join(taskStore.taskDirectory(task.id), test.evidencePath));
    } catch {
      throw new Error(`测试记录 ${test.id} 缺少 AIW 执行证据：${test.evidencePath}`);
    }
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== test.evidenceSha256) {
      throw new Error(`测试记录 ${test.id} 的执行证据哈希不一致：${test.evidencePath}`);
    }
  }
}

function isDeliveryUnit(node: Task['nodes'][string]): boolean {
  return node.phase === 'implement' && node.generatedFromPlan === true;
}

/**
 * `task review` has a fixed two-level interaction: first choose whether this
 * item continues in the current scope, then choose one of the AI's business
 * alternatives. The register is therefore a proposal-only record: waiting is
 * recorded by AIW, and neither scope changes nor delivery risks belong here.
 */
function validateClarifyDecisionChoices(register: import('../domain/decision-register.js').DecisionRegister): void {
  for (const item of register.items) {
    const recommended = item.options.find((option) => option.id === item.recommendation.optionId);
    if (recommended === undefined) {
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
  const upstream = dependencyClosure(task, nodeId).flatMap((dependency) => {
    const upstreamNode = task.nodes[dependency];
    return upstreamNode === undefined || upstreamNode.phase === 'intake'
      ? []
      : outputPathsForCompletedRun(dependency, upstreamNode);
  });
  return [...new Set([
    ...manifest.files.filter((file) => file.evidenceEligible).map((file) => file.path),
    ...Object.values(task.sources).flatMap((source) => [source.snapshotPath, source.metaPath]),
    ...registeredDecisionFactPaths(task),
    ...upstream,
    ...outputPathsForNextRun(nodeId, node),
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
    ...(task.workflowPath === undefined ? [] : [taskFactPath(task.workflowPath.assessmentPath)]),
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
