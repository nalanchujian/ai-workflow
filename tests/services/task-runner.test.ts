import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import { ContextBuilder } from '../../src/services/context-builder.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { TaskRunner, handoffEvidencePaths } from '../../src/services/task-runner.js';
import { TaskStore } from '../../src/services/task-store.js';
import { handoffPath } from '../../src/domain/handoff.js';
import { ExecutableNotFoundError } from '../../src/ports/process-runner.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTempDirectory));
});

describe('TaskRunner', () => {
  it('creates a dry-run context with the locked method and never starts Codex', async () => {
    const fixture = await createRunnerFixture({ exitCode: 0 });

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: true, includes: [] });

    expect(result.status).toBe('succeeded');
    expect(fixture.processCalls).toHaveLength(0);
    expect(await readFile(join(result.runDirectory, 'context.md'), 'utf8')).toContain('<method-source id="superpowers:brainstorming" trust="lower-priority-guidance">');
    const manifest = JSON.parse(await readFile(join(fixture.taskStore.taskDirectory('refund-123'), 'runs', 'run-1', 'context-manifest.json'), 'utf8')) as { budget: { breakdown: Array<{ category: string; label: string }> } };
    expect(manifest.budget.breakdown).toContainEqual(expect.objectContaining({ category: 'runtime-overhead', label: '运行约束与提示词结构' }));
    expect((await fixture.taskStore.load('refund-123')).nodes.clarify?.status).toBe('ready');
  });

  it('marks the node as failed when Codex is unavailable', async () => {
    const fixture = await createRunnerFixture({ missingExecutable: true });

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result.status).toBe('unavailable');
    expect((await fixture.taskStore.load('refund-123')).nodes.clarify?.status).toBe('failed');
  });

  it('retries a failed node directly and preserves its prior failure event', async () => {
    const fixture = await createRunnerFixture({
      exitCode: 0,
      writeArtifact: '# 需求澄清\n\n## 结论\n\n退款申请需要管理员审批。\n',
    });
    const task = await fixture.taskStore.load('refund-123');
    task.nodes.clarify!.status = 'failed';
    task.events.push({ type: 'fail', nodeId: 'clarify', at: '2026-08-17T00:00:00.000Z', reason: 'Codex CLI 异常退出' });
    await fixture.taskStore.update(task);

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result.status).toBe('succeeded');
    const retried = await fixture.taskStore.load('refund-123');
    expect(retried.nodes.clarify?.status).toBe('awaiting_approval');
    expect(retried.events).toContainEqual(expect.objectContaining({ type: 'fail', nodeId: 'clarify', reason: 'Codex CLI 异常退出' }));
  });

  it('overwrites a completed node and clears its downstream task facts before running again', async () => {
    const fixture = await createRunnerFixture({
      changeSnapshots: [[], ['.aiw/tasks/refund-123/artifacts/brief.md', '.aiw/tasks/refund-123/handoffs/clarify/r2.yaml']],
      writeArtifact: '# 需求澄清\n\n## 结论\n\n这是覆盖重跑后生成的新澄清结论。\n',
    });
    const task = await fixture.taskStore.load('refund-123');
    task.nodes.clarify!.status = 'completed';
    task.nodes.clarify!.revision = 1;
    task.nodes.solution!.status = 'completed';
    task.nodes.solution!.revision = 1;
    task.approvalRefs = ['approvals/clarify/r1.yaml'];
    await fixture.taskStore.update(task);
    await fixture.taskStore.createFact(task.id, 'artifacts/brief.md', '# 旧澄清\n');
    await fixture.taskStore.createFact(task.id, 'artifacts/solution.md', '# 旧方案\n');
    await fixture.taskStore.createFact(task.id, 'handoffs/clarify/r1.yaml', '旧交接\n');
    await fixture.taskStore.createFact(task.id, 'approvals/clarify/r1.yaml', '旧审批\n');

    const result = await fixture.runner.run({ taskId: task.id, nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result.status).toBe('succeeded');
    expect((await fixture.taskStore.load(task.id)).nodes.clarify).toMatchObject({ status: 'awaiting_approval', revision: 2 });
    await expect(readFile(join(fixture.taskStore.taskDirectory(task.id), 'artifacts', 'brief.md'), 'utf8')).resolves.toContain('覆盖重跑后');
    await expect(readFile(join(fixture.taskStore.taskDirectory(task.id), 'artifacts', 'solution.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(fixture.taskStore.taskDirectory(task.id), 'handoffs', 'clarify', 'r1.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(fixture.taskStore.taskDirectory(task.id), 'approvals', 'clarify', 'r1.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a run when another process holds the task execution lock', async () => {
    const fixture = await createRunnerFixture({
      runLock: { async acquire() { return undefined; } },
    });

    await expect(fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: true, includes: [] }))
      .rejects.toMatchObject({ code: 'TASK_BUSY' });
    expect(fixture.processCalls).toHaveLength(0);
  });

  it('recovers a stranded running node after acquiring its stale execution lock', async () => {
    const fixture = await createRunnerFixture({});
    const task = await fixture.taskStore.load('refund-123');
    task.nodes.clarify!.status = 'running';
    task.events.push({ type: 'start', nodeId: 'clarify', at: '2026-08-13T00:00:00.000Z', runId: 'stranded-run' });
    await fixture.taskStore.update(task);

    await expect(fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] }))
      .rejects.toMatchObject({ code: 'RUN_RECOVERED' });
    expect((await fixture.taskStore.load('refund-123')).nodes.clarify?.status).toBe('failed');
    expect(fixture.processCalls).toHaveLength(0);
  });

  it('counts the locked skill and method content in the run budget', async () => {
    const fixture = await createRunnerFixture({ maxTokens: 10 });

    await expect(fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: true, includes: [] }))
      .rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' });
  });

  it('counts the final rendered prompt overhead instead of only the task files', async () => {
    const fixture = await createRunnerFixture({ maxTokens: 800 });

    await expect(fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: true, includes: [] }))
      .rejects.toMatchObject({
        code: 'CONTEXT_BUDGET_EXCEEDED',
        message: expect.stringContaining('运行约束与提示词结构'),
      });
    expect(fixture.processCalls).toHaveLength(0);
  });

  it('rejects a blocked downstream node before invoking Codex', async () => {
    const fixture = await createRunnerFixture({});

    await expect(fixture.runner.run({ taskId: 'refund-123', nodeId: 'solution', dryRun: false, includes: [] }))
      .rejects.toMatchObject({ code: 'NODE_NOT_RUNNABLE' });
    expect(fixture.processCalls).toHaveLength(0);
  });

  it('blocks execution when the business working tree already has uncommitted changes', async () => {
    const fixture = await createRunnerFixture({ changeSnapshots: [['src/existing-change.ts']] });

    await expect(fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] }))
      .rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
    expect(fixture.processCalls).toHaveLength(0);
  });

  it('fails a node and records evidence when Codex changes a path outside the declared scope', async () => {
    const fixture = await createRunnerFixture({ changeSnapshots: [[], ['.aiw/tasks/refund-123/artifacts/brief.md', 'src/unapproved.ts']] });
    await mkdir(join(fixture.taskStore.taskDirectory('refund-123'), 'artifacts'), { recursive: true });
    await writeFile(join(fixture.taskStore.taskDirectory('refund-123'), 'artifacts', 'brief.md'), '# Brief\n', 'utf8');

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result).toMatchObject({ status: 'failed', error: { code: 'CHANGE_SCOPE_VIOLATION' } });
    expect((await fixture.taskStore.load('refund-123')).nodes.clarify?.status).toBe('failed');
    await expect(readFile(join(fixture.taskStore.taskDirectory('refund-123'), 'runs', 'run-1', 'change-diff.json'), 'utf8'))
      .resolves.toContain('src/unapproved.ts');
  });

  it('records a baseline, diff hash and output hashes as the completion evidence', async () => {
    const fixture = await createRunnerFixture({
      changeSnapshots: [[], ['.aiw/tasks/refund-123/artifacts/brief.md']],
      writeArtifact: '# 需求澄清\n\n## 结论\n\n退款申请需要管理员审批。\n',
    });

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result.status).toBe('succeeded');
    const evidence = JSON.parse(await readFile(join(fixture.taskStore.taskDirectory('refund-123'), 'runs', 'run-1', 'change-evidence.json'), 'utf8')) as Record<string, unknown>;
    expect(evidence).toMatchObject({ baseline: { changedPaths: [], outputs: expect.arrayContaining([{ path: 'artifacts/brief.md' }, { path: handoffPath('clarify', 1) }]) }, changedFiles: [{ path: '.aiw/tasks/refund-123/artifacts/brief.md' }], artifacts: expect.arrayContaining([{ path: 'artifacts/brief.md', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, { path: handoffPath('clarify', 1), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]), diff: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect((await fixture.taskStore.load('refund-123')).events.at(-1)).toMatchObject({ type: 'succeed', runId: 'run-1', evidencePath: 'runs/run-1/change-evidence.json' });
  });

  it('fails and preserves evidence when Codex changes the Git revision', async () => {
    const fixture = await createRunnerFixture({
      changeSnapshots: [[], ['.aiw/tasks/refund-123/artifacts/brief.md']],
      gitRevisions: [{ head: 'base-commit', branch: 'main' }, { head: 'agent-commit', branch: 'main' }],
      writeArtifact: '# 需求澄清\n\n## 结论\n\n退款申请需要管理员审批。\n',
    });

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result).toMatchObject({ status: 'failed', error: { code: 'GIT_HISTORY_MUTATION' } });
    const evidence = JSON.parse(await readFile(join(fixture.taskStore.taskDirectory('refund-123'), 'runs', 'run-1', 'change-evidence.json'), 'utf8')) as Record<string, unknown>;
    expect(evidence).toMatchObject({ git: { before: { head: 'base-commit' }, after: { head: 'agent-commit' }, historyChanged: true }, failure: { stage: 'git-history', code: 'GIT_HISTORY_MUTATION' } });
  });

  it('stores a patch for an allowed untracked artifact', async () => {
    const fixture = await createRunnerFixture({
      changeSnapshots: [[], ['.aiw/tasks/refund-123/artifacts/brief.md']],
      untrackedPaths: ['.aiw/tasks/refund-123/artifacts/brief.md'],
      writeArtifact: '# 需求澄清\n\n## 结论\n\n退款申请需要管理员审批。\n',
    });

    await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    await expect(readFile(join(fixture.taskStore.taskDirectory('refund-123'), 'runs', 'run-1', 'change.patch'), 'utf8'))
      .resolves.toContain('退款申请需要管理员审批');
  });

  it('records a cancelled run as a cancelled node', async () => {
    const fixture = await createRunnerFixture({ signal: 'SIGTERM' });

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result.status).toBe('cancelled');
    expect((await fixture.taskStore.load('refund-123')).nodes.clarify?.status).toBe('cancelled');
  });

  it('allows a cancelled node to be run again with a new current result', async () => {
    const fixture = await createRunnerFixture({
      changeSnapshots: [[], ['.aiw/tasks/refund-123/artifacts/brief.md', '.aiw/tasks/refund-123/handoffs/clarify/r1.yaml']],
      writeArtifact: '# 需求澄清\n\n## 结论\n\n退款申请需要管理员审批。\n',
    });
    const cancelled = await fixture.taskStore.load('refund-123');
    cancelled.nodes.clarify.status = 'cancelled';
    await fixture.taskStore.update(cancelled);

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result.status).toBe('succeeded');
    expect((await fixture.taskStore.load('refund-123')).nodes.clarify?.status).toBe('awaiting_approval');
  });

  it('rejects an empty or structurally invalid declared artifact', async () => {
    const fixture = await createRunnerFixture({ changeSnapshots: [[], ['.aiw/tasks/refund-123/artifacts/brief.md']], writeArtifact: 'done\n' });

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result).toMatchObject({ status: 'failed', error: { code: 'ARTIFACT_INVALID' } });
    const evidence = JSON.parse(await readFile(join(fixture.taskStore.taskDirectory('refund-123'), 'runs', 'run-1', 'change-evidence.json'), 'utf8')) as Record<string, unknown>;
    expect(evidence).toMatchObject({ failure: { stage: 'artifact', code: 'ARTIFACT_INVALID' } });
  });

  it('rejects clarify output that presents external waiting as an AI business option', async () => {
    const fixture = await createRunnerFixture({
      changeSnapshots: [[], ['.aiw/tasks/refund-123/artifacts/decision-register.yaml']],
      writeArtifact: '# 需求澄清\n\n## 结论\n\n退款申请需要管理员审批。\n',
      decisionRegister: `schemaVersion: aiw.decision-register/v1
items:
  - id: DEC-API-01
    title: 退款接口契约
    detail:
      question: 本期使用哪一套退款接口？
      background: 当前仓库没有可确认的接口字段与错误码约定。
      impact: 不确认会导致页面行为和验收标准无法对齐。
    type: external-contract
    affects:
      acceptanceRefs: [AC-01]
      workUnits: [implement]
    status: proposed
    options:
      - id: wait-api
        title: 等待正式接口
        tradeoffs: 接口口径可靠，但需要等待后端提供契约。
        effect: waiting_external
    recommendation:
      optionId: wait-api
      rationale: 当前没有可信的接口契约。
`,
    });

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result).toMatchObject({ status: 'failed', error: { code: 'ARTIFACT_INVALID', message: expect.stringContaining('只能表示“本期继续”') } });
  });

  it('rejects a malformed structured handoff and preserves failure evidence', async () => {
    const fixture = await createRunnerFixture({
      changeSnapshots: [[], ['.aiw/tasks/refund-123/artifacts/brief.md', '.aiw/tasks/refund-123/handoffs/clarify/r1.yaml']],
      writeArtifact: '# 需求澄清\n\n## 结论\n\n退款申请需要管理员审批。\n',
      writeHandoff: 'schemaVersion: aiw.handoff/v1\n',
    });

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result).toMatchObject({ status: 'failed', error: { code: 'ARTIFACT_INVALID' } });
    const evidence = JSON.parse(await readFile(join(fixture.taskStore.taskDirectory('refund-123'), 'runs', 'run-1', 'change-evidence.json'), 'utf8')) as Record<string, unknown>;
    expect(evidence).toMatchObject({ failure: { stage: 'artifact', code: 'ARTIFACT_INVALID' } });
  });

  it('allows an implementation handoff to cite only its declared work-unit context', () => {
    const task = createSevenPhaseTask();
    task.nodes.implement!.contextPath = 'artifacts/work-units/r2/implement-performance.md';

    const evidencePaths = handoffEvidencePaths(task, 'implement');

    expect(evidencePaths).toContain('artifacts/work-units/r2/implement-performance.md');
    expect(evidencePaths).not.toContain('artifacts/work-units/r2/other-unit.md');
  });

  it('rejects a valid-looking artifact left over from a previous run', async () => {
    const fixture = await createRunnerFixture({ changeSnapshots: [[], ['.aiw/tasks/refund-123/artifacts/brief.md']] });
    await mkdir(join(fixture.taskStore.taskDirectory('refund-123'), 'artifacts'), { recursive: true });
    await writeFile(join(fixture.taskStore.taskDirectory('refund-123'), 'artifacts', 'brief.md'), validBrief('这是上一次运行遗留的产物。'), 'utf8');
    await writeFile(join(fixture.taskStore.taskDirectory('refund-123'), 'artifacts', 'questions.md'), '# 需求疑问\n\n## 开放问题\n\n当前没有阻塞性待确认事项。\n\n## 影响\n\n后续可以按验收清单继续推进。\n', 'utf8');
    await writeFile(join(fixture.taskStore.taskDirectory('refund-123'), 'artifacts', 'acceptance.md'), '# 验收标准\n\n## 验收项\n\n- AC-01：用户可以提交退款申请并查看处理结果。\n', 'utf8');
    await writeFile(join(fixture.taskStore.taskDirectory('refund-123'), 'artifacts', 'acceptance.yaml'), 'schemaVersion: aiw.acceptance-catalog/v1\nitems:\n  - id: AC-01\n    title: 退款申请\n    description: 用户可以提交退款申请并查看处理结果。\n', 'utf8');
    await writeFile(join(fixture.taskStore.taskDirectory('refund-123'), 'artifacts', 'decision-register.yaml'), 'schemaVersion: aiw.decision-register/v1\nitems: []\n', 'utf8');
    await writeHandoff(fixture.taskStore, 'refund-123');

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result).toMatchObject({ status: 'failed', error: { code: 'ARTIFACT_STALE' } });
    const evidence = JSON.parse(await readFile(join(fixture.taskStore.taskDirectory('refund-123'), 'runs', 'run-1', 'change-evidence.json'), 'utf8')) as Record<string, unknown>;
    expect(evidence).toMatchObject({ failure: { stage: 'artifact', code: 'ARTIFACT_STALE' } });
  });
});

async function createRunnerFixture(options: {
  exitCode?: number;
  missingExecutable?: boolean;
  maxTokens?: number;
  runLock?: { acquire(input: { taskId: string }): Promise<undefined> };
  changeSnapshots?: string[][];
  untrackedPaths?: string[];
  gitRevisions?: Array<{ head?: string; branch?: string }>;
  signal?: string | null;
  writeArtifact?: string;
  writeHandoff?: string;
  decisionRegister?: string;
}) {
  const projectRoot = await temporaryDirectory();
  const taskStore = new TaskStore(projectRoot);
  const task = createSevenPhaseTask();
  task.repository = projectRoot;
  await taskStore.create(task);
  await writeFile(join(taskStore.taskDirectory(task.id), 'task.md'), '# 退款需求\n', 'utf8');

  const registry = new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml'));
  const skill = task.nodes.clarify?.skill;
  if (skill === undefined) {
    throw new Error('fixture skill missing');
  }
  await registry.replace({
    skills: [{
      name: skill.name,
      version: skill.version,
      description: '澄清需求',
      phases: ['clarify'],
      registrySource: skill.registrySource,
      sha256: skill.sha256,
      methodSources: skill.methodSources,
      body: '澄清需求并输出 brief。',
    }],
    profiles: [],
  });

  const processCalls: unknown[] = [];
  const adapter = new CodexAdapter({
    processRunner: {
      async run(input) {
        processCalls.push(input);
        if (options.missingExecutable) {
          throw new ExecutableNotFoundError('codex');
        }
        if (options.writeArtifact !== undefined) {
          await mkdir(join(taskStore.taskDirectory(task.id), 'artifacts'), { recursive: true });
          await writeFile(join(taskStore.taskDirectory(task.id), 'artifacts', 'brief.md'), options.writeArtifact === 'done\n' ? options.writeArtifact : validBrief(options.writeArtifact), 'utf8');
          await writeFile(join(taskStore.taskDirectory(task.id), 'artifacts', 'questions.md'), '# 需求疑问\n\n## 开放问题\n\n当前没有阻塞性待确认事项。\n\n## 影响\n\n可按照验收清单继续完成技术方案。\n', 'utf8');
          await writeFile(join(taskStore.taskDirectory(task.id), 'artifacts', 'acceptance.md'), '# 验收标准\n\n## 验收项\n\n- AC-01：用户可以提交退款申请并查看处理结果。\n', 'utf8');
          await writeFile(join(taskStore.taskDirectory(task.id), 'artifacts', 'acceptance.yaml'), 'schemaVersion: aiw.acceptance-catalog/v1\nitems:\n  - id: AC-01\n    title: 退款申请\n    description: 用户可以提交退款申请并查看处理结果。\n', 'utf8');
          await writeFile(join(taskStore.taskDirectory(task.id), 'artifacts', 'decision-register.yaml'), options.decisionRegister ?? 'schemaVersion: aiw.decision-register/v1\nitems: []\n', 'utf8');
          await writeHandoff(taskStore, task.id, options.writeHandoff);
        }
        return { exitCode: options.exitCode ?? 0, signal: options.signal ?? null, stdout: '', stderr: '', timedOut: false };
      },
    },
  });
  const runner = new TaskRunner({
    taskStore,
    skillRegistry: registry,
    methodSourceResolver: {
      async resolve() { throw new Error('not used'); },
      async assertLocked() {},
      async readLocked(source) { return { source, content: '先理解问题。' }; },
    },
    contextBuilder: new ContextBuilder({ taskDirectory: (input) => taskStore.taskDirectory(input.id), projectRoot: (input) => input.repository, maxTokens: options.maxTokens }),
    taskFactGuard: { async assertCommitted() {}, async actor() { return 'tester'; } } as never,
    adapter,
    changeInspector: {
      async changedPaths() { return options.changeSnapshots?.shift() ?? []; },
      async diff() { return 'diff --git a/src/example.ts b/src/example.ts\n'; },
      async untrackedPaths() { return options.untrackedPaths ?? []; },
      async revision() { return options.gitRevisions?.shift() ?? { head: 'base-commit', branch: 'main' }; },
    },
    runtimeRoot: join(projectRoot, '.aiw-runtime'),
    runIdFactory: () => 'run-1',
    ...(options.runLock === undefined ? {} : { runLock: options.runLock }),
  });
  return { runner, taskStore, processCalls };
}

async function writeHandoff(taskStore: TaskStore, taskId: string, content?: string): Promise<void> {
  const task = await taskStore.load(taskId);
  const node = task.nodes.clarify;
  if (node === undefined) throw new Error('clarify node missing');
  const path = handoffPath('clarify', node.revision + 1);
  await mkdir(join(taskStore.taskDirectory(task.id), 'handoffs', 'clarify'), { recursive: true });
  await writeFile(join(taskStore.taskDirectory(task.id), path), content ?? `schemaVersion: aiw.handoff/v1\ntaskId: ${task.id}\nnodeId: clarify\nphase: clarify\nrevision: ${node.revision + 1}\nsummary: 已完成需求澄清并形成可追溯交接。\nfacts:\n  - id: FACT-01\n    statement: 已完成退款申请需求的基础澄清。\n    evidence:\n      - path: artifacts/brief.md\ndecisions: []\nacceptance: []\nchanges: []\nverification: []\nopenRisks: []\n`, 'utf8');
}

function validBrief(content: string): string {
  return `# 需求摘要\n\n## 目标与范围\n\n${content.trim()}\n\n## 来源依据\n\n- sources/requirements/r1/snapshot.md\n`;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await createTempDirectory('aiw-task-runner-');
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}
