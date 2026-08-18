import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import { ContextBuilder } from '../../src/services/context-builder.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { TaskRunner, handoffEvidencePaths } from '../../src/services/task-runner.js';
import { TaskStore } from '../../src/services/task-store.js';
import { handoffPath, nextArtifactPath, outputPathsForCompletedRun, validateHandoff } from '../../src/domain/handoff.js';
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

  it('creates a new revision when a completed node is re-run and preserves historical facts', async () => {
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
    await fixture.taskStore.createFact(task.id, 'artifacts/clarify/r1/brief.md', '# 旧澄清\n');
    await fixture.taskStore.createFact(task.id, 'artifacts/solution/r1/solution.md', '# 旧方案\n');
    await fixture.taskStore.createFact(task.id, 'handoffs/clarify/r1.yaml', '旧交接\n');
    await fixture.taskStore.createFact(task.id, 'approvals/clarify/r1.yaml', '旧审批\n');

    const result = await fixture.runner.run({ taskId: task.id, nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result.status).toBe('succeeded');
    expect((await fixture.taskStore.load(task.id)).nodes.clarify).toMatchObject({ status: 'awaiting_approval', revision: 2 });
    await expect(readFile(join(fixture.taskStore.taskDirectory(task.id), 'artifacts', 'clarify', 'r2', 'brief.md'), 'utf8')).resolves.toContain('覆盖重跑后');
    await expect(readFile(join(fixture.taskStore.taskDirectory(task.id), 'artifacts', 'clarify', 'r1', 'brief.md'), 'utf8')).resolves.toContain('旧澄清');
    await expect(readFile(join(fixture.taskStore.taskDirectory(task.id), 'artifacts', 'solution', 'r1', 'solution.md'), 'utf8')).resolves.toContain('旧方案');
    await expect(readFile(join(fixture.taskStore.taskDirectory(task.id), 'handoffs', 'clarify', 'r1.yaml'), 'utf8')).resolves.toContain('旧交接');
    await expect(readFile(join(fixture.taskStore.taskDirectory(task.id), 'approvals', 'clarify', 'r1.yaml'), 'utf8')).resolves.toContain('旧审批');
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

  it('requires invalidated downstream stages to wait for their invalidated dependencies', async () => {
    const fixture = await createRunnerFixture({});
    const task = await fixture.taskStore.load('refund-123');
    task.nodes.clarify!.status = 'completed';
    task.nodes.solution!.status = 'invalidated';
    task.nodes.plan!.status = 'invalidated';
    await fixture.taskStore.update(task);

    await expect(fixture.runner.run({ taskId: 'refund-123', nodeId: 'plan', dryRun: false, includes: [] }))
      .rejects.toMatchObject({ code: 'NODE_NOT_RUNNABLE', message: expect.stringContaining('solution') });
    expect(fixture.processCalls).toHaveLength(0);
  });

  it('invalidates an upstream stage before a downstream run when its approved artifact was changed', async () => {
    const fixture = await createRunnerFixture({
      changeSnapshots: [[], ['.aiw/tasks/refund-123/artifacts/brief.md', '.aiw/tasks/refund-123/handoffs/clarify/r1.yaml']],
      writeArtifact: '# 需求澄清\n\n## 结论\n\n退款申请需要管理员审批。\n',
    });
    await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    const completed = await fixture.taskStore.load('refund-123');
    const clarify = completed.nodes.clarify!;
    const artifactHashes = Object.fromEntries(await Promise.all(
      outputPathsForCompletedRun('clarify', clarify).map(async (path) => [
        path,
        'sha256:' + createHash('sha256').update(await readFile(join(fixture.taskStore.taskDirectory(completed.id), path))).digest('hex'),
      ]),
    ));
    completed.nodes.clarify!.status = 'completed';
    completed.nodes.solution!.status = 'ready';
    completed.approvalRefs = ['approvals/clarify/r1.yaml'];
    await fixture.taskStore.createFact(completed.id, 'approvals/clarify/r1.yaml', JSON.stringify({
      nodeId: 'clarify',
      nodeRevision: 1,
      artifactHashes,
      decision: 'approved',
      actor: 'tech-lead',
      at: '2026-08-18T00:00:00.000Z',
    }) + '\n');
    await fixture.taskStore.update(completed);
    await writeFile(join(fixture.taskStore.taskDirectory(completed.id), 'artifacts', 'clarify', 'r1', 'brief.md'), validBrief('审批后被改写的需求结论。'), 'utf8');

    await expect(fixture.runner.run({ taskId: completed.id, nodeId: 'solution', dryRun: false, includes: [] }))
      .rejects.toMatchObject({ code: 'ARTIFACT_STALE', message: expect.stringContaining('已标记失效') });

    const invalidated = await fixture.taskStore.load(completed.id);
    expect(invalidated.nodes.clarify?.status).toBe('invalidated');
    expect(invalidated.nodes.solution?.status).toBe('invalidated');
    expect(fixture.processCalls).toHaveLength(1);
  });

  it('blocks execution when the business working tree already has uncommitted changes', async () => {
    const fixture = await createRunnerFixture({ changeSnapshots: [['src/existing-change.ts']] });

    await expect(fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] }))
      .rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
    expect(fixture.processCalls).toHaveLength(0);
  });

  it('stops before Codex when a committed source snapshot no longer matches its task hash', async () => {
    const fixture = await createRunnerFixture({});
    const task = await fixture.taskStore.load('refund-123');
    const original = '# 原始需求\n';
    const contentSha256 = createHash('sha256').update(original, 'utf8').digest('hex');
    task.sources.requirements = {
      kind: 'connected-document',
      origin: 'https://example.test/requirements',
      revision: 1,
      snapshotPath: 'sources/requirements/r1/snapshot.md',
      metaPath: 'sources/requirements/r1/meta.json',
      contentSha256,
    };
    await fixture.taskStore.update(task);
    const sourceDirectory = join(fixture.taskStore.taskDirectory(task.id), 'sources', 'requirements', 'r1');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, 'snapshot.md'), '# 被手动改写的需求\n', 'utf8');
    await writeFile(join(sourceDirectory, 'meta.json'), JSON.stringify({
      sourceId: 'requirements',
      kind: 'connected-document',
      origin: 'https://example.test/requirements',
      revision: 1,
      fetchedAt: '2026-08-18T00:00:00.000Z',
      contentSha256,
      extractor: 'test/fixture',
    }) + '\n', 'utf8');

    await expect(fixture.runner.run({ taskId: task.id, nodeId: 'clarify', dryRun: false, includes: [] }))
      .rejects.toMatchObject({ code: 'SOURCE_INTEGRITY_INVALID', message: expect.stringContaining('task source refresh') });
    expect(fixture.processCalls).toHaveLength(0);
  });

  it('allows business code changes outside a predeclared path and records them as evidence', async () => {
    const fixture = await createRunnerFixture({
      changeSnapshots: [[], ['.aiw/tasks/refund-123/artifacts/brief.md', 'src/unapproved.ts']],
      writeArtifact: '# 需求澄清\n\n## 结论\n\n退款申请需要管理员审批。\n',
    });

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result.status).toBe('succeeded');
    expect((await fixture.taskStore.load('refund-123')).nodes.clarify?.status).toBe('awaiting_approval');
    await expect(readFile(join(fixture.taskStore.taskDirectory('refund-123'), 'runs', 'run-1', 'change-diff.json'), 'utf8'))
      .resolves.toContain('src/unapproved.ts');
    await expect(readFile(join(fixture.taskStore.taskDirectory('refund-123'), 'runs', 'run-1', 'change-scope.json'), 'utf8'))
      .resolves.toContain('"businessFilePolicy": "unrestricted"');
  });

  it('still rejects writes to task facts outside the current task and node outputs', async () => {
    const fixture = await createRunnerFixture({
      changeSnapshots: [[], ['.aiw/config.yaml', '.aiw/tasks/refund-123/artifacts/brief.md']],
      writeArtifact: '# 需求澄清\n\n## 结论\n\n退款申请需要管理员审批。\n',
    });

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'TASK_FACT_WRITE_VIOLATION', message: expect.stringContaining('.aiw/config.yaml') },
    });
  });

  it('explains the target revision when a re-run writes an old handoff path', async () => {
    const fixture = await createRunnerFixture({
      changeSnapshots: [[], ['.aiw/tasks/refund-123/handoffs/clarify/r1.yaml']],
    });
    const task = await fixture.taskStore.load('refund-123');
    task.nodes.clarify = { ...task.nodes.clarify!, status: 'completed', revision: 1 };
    await fixture.taskStore.update(task);

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'TASK_FACT_WRITE_VIOLATION', message: expect.stringContaining('本次运行只允许写入 handoffs/clarify/r2.yaml') },
    });
  });

  it('records a baseline, diff hash and output hashes as the completion evidence', async () => {
    const fixture = await createRunnerFixture({
      changeSnapshots: [[], ['.aiw/tasks/refund-123/artifacts/brief.md']],
      writeArtifact: '# 需求澄清\n\n## 结论\n\n退款申请需要管理员审批。\n',
    });

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result.status).toBe('succeeded');
    const evidence = JSON.parse(await readFile(join(fixture.taskStore.taskDirectory('refund-123'), 'runs', 'run-1', 'change-evidence.json'), 'utf8')) as Record<string, unknown>;
    expect(evidence).toMatchObject({ baseline: { changedPaths: [], outputs: expect.arrayContaining([{ path: 'artifacts/clarify/r1/brief.md' }, { path: handoffPath('clarify', 1) }]) }, changedFiles: [{ path: '.aiw/tasks/refund-123/artifacts/clarify/r1/brief.md' }], artifacts: expect.arrayContaining([{ path: 'artifacts/clarify/r1/brief.md', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, { path: handoffPath('clarify', 1), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]), diff: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
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

  it('allows an implementation handoff to cite its injected work-unit context only', () => {
    const task = createSevenPhaseTask();
    task.nodes.implement!.contextPath = 'artifacts/work-units/r2/implement-performance.md';

    const evidencePaths = handoffEvidencePaths(task, 'implement', {
      files: [
        { role: 'artifact', path: 'artifacts/work-units/r2/implement-performance.md', sha256: 'a'.repeat(64), evidenceEligible: true },
        { role: 'additional', path: 'src/temporary-reference.ts', sha256: 'b'.repeat(64), evidenceEligible: false },
      ],
    });

    expect(evidencePaths).toContain('artifacts/work-units/r2/implement-performance.md');
    expect(evidencePaths).not.toContain('artifacts/work-units/r2/other-unit.md');
    expect(evidencePaths).not.toContain('src/temporary-reference.ts');
  });

  it('uses the actual context manifest as the handoff evidence allowlist', () => {
    const task = createSevenPhaseTask();
    task.sources.requirements = {
      kind: 'connected-document',
      origin: 'https://example.larksuite.com/docx/requirement',
      revision: 1,
      snapshotPath: 'sources/requirements/r1/snapshot.md',
      metaPath: 'sources/requirements/r1/meta.json',
      contentSha256: 'f'.repeat(64),
    };
    const evidencePaths = handoffEvidencePaths(task, 'solution', {
      files: [
        { role: 'handoff', path: handoffPath('clarify', 1), sha256: 'a'.repeat(64), evidenceEligible: true },
        { role: 'task', path: 'task.yaml', sha256: 'b'.repeat(64), evidenceEligible: true },
        { role: 'artifact', path: 'artifacts/clarify/r0/decision-register.yaml', sha256: 'c'.repeat(64), evidenceEligible: true },
        { role: 'artifact', path: 'decisions/DEC-API-01/r1.yaml', sha256: 'd'.repeat(64), evidenceEligible: true },
        { role: 'additional', path: 'src/temporary-reference.ts', sha256: 'e'.repeat(64), evidenceEligible: false },
      ],
    });

    expect(evidencePaths).toEqual(expect.arrayContaining([
      handoffPath('clarify', 1),
      'task.yaml',
      'artifacts/clarify/r0/decision-register.yaml',
      'decisions/DEC-API-01/r1.yaml',
      'artifacts/solution/r1/solution.md',
      'sources/requirements/r1/snapshot.md',
    ]));
    expect(evidencePaths).not.toContain('src/temporary-reference.ts');
    expect(() => validateHandoff(`schemaVersion: aiw.handoff/v1
taskId: ${task.id}
nodeId: solution
phase: solution
revision: 1
summary: 已根据任务事实形成可追溯技术方案。
facts:
  - id: FACT-01
    statement: 当前技术方案依据已固化的需求范围形成。
    evidence:
      - path: sources/requirements/r1/snapshot.md
  - id: FACT-02
    statement: 人工决策已记录在当前任务事实中。
    evidence:
      - path: task.yaml
decisions:
  - statement: 采用已确认的接口边界继续技术方案。
    evidence:
      - path: decisions/DEC-API-01/r1.yaml
acceptance: []
changes: []
verification: []
openRisks: []
`, { taskId: task.id, nodeId: 'solution', phase: 'solution', revision: 1, evidencePaths })).not.toThrow();
  });

  it('rejects a valid-looking artifact left over from a previous run', async () => {
    const fixture = await createRunnerFixture({ changeSnapshots: [[], ['.aiw/tasks/refund-123/artifacts/brief.md']] });
    const staleArtifacts = join(fixture.taskStore.taskDirectory('refund-123'), 'artifacts', 'clarify', 'r1');
    await mkdir(staleArtifacts, { recursive: true });
    await writeFile(join(staleArtifacts, 'brief.md'), validBrief('这是上一次运行遗留的产物。'), 'utf8');
    await writeFile(join(staleArtifacts, 'questions.md'), '# 需求疑问\n\n## 开放问题\n\n当前没有阻塞性待确认事项。\n\n## 影响\n\n后续可以按验收清单继续推进。\n', 'utf8');
    await writeFile(join(staleArtifacts, 'acceptance.md'), '# 验收标准\n\n## 验收项\n\n- AC-01：用户可以提交退款申请并查看处理结果。\n', 'utf8');
    await writeFile(join(staleArtifacts, 'acceptance.yaml'), 'schemaVersion: aiw.acceptance-catalog/v1\nitems:\n  - id: AC-01\n    title: 退款申请\n    description: 用户可以提交退款申请并查看处理结果。\n', 'utf8');
    await writeFile(join(staleArtifacts, 'decision-register.yaml'), 'schemaVersion: aiw.decision-register/v1\nitems: []\n', 'utf8');
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
          const current = await taskStore.load(task.id);
          const clarify = current.nodes.clarify!;
          const artifact = (name: string) => {
            const path = nextArtifactPath('clarify', clarify, `artifacts/${name}`);
            return join(taskStore.taskDirectory(task.id), path);
          };
          await mkdir(join(artifact('brief.md'), '..'), { recursive: true });
          await writeFile(artifact('brief.md'), options.writeArtifact === 'done\n' ? options.writeArtifact : validBrief(options.writeArtifact), 'utf8');
          await writeFile(artifact('questions.md'), '# 需求疑问\n\n## 开放问题\n\n当前没有阻塞性待确认事项。\n\n## 影响\n\n可按照验收清单继续完成技术方案。\n', 'utf8');
          await writeFile(artifact('acceptance.md'), '# 验收标准\n\n## 验收项\n\n- AC-01：用户可以提交退款申请并查看处理结果。\n', 'utf8');
          await writeFile(artifact('acceptance.yaml'), 'schemaVersion: aiw.acceptance-catalog/v1\nitems:\n  - id: AC-01\n    title: 退款申请\n    description: 用户可以提交退款申请并查看处理结果。\n', 'utf8');
          await writeFile(artifact('decision-register.yaml'), options.decisionRegister ?? 'schemaVersion: aiw.decision-register/v1\nitems: []\n', 'utf8');
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
      async changedPaths() {
        const paths = options.changeSnapshots?.shift() ?? [];
        const current = await taskStore.load(task.id);
        const clarify = current.nodes.clarify!;
        return paths.map((path) => mapLegacyArtifactPath(path, task.id, clarify));
      },
      async diff() { return 'diff --git a/src/example.ts b/src/example.ts\n'; },
      async untrackedPaths() {
        const current = await taskStore.load(task.id);
        return (options.untrackedPaths ?? []).map((path) => mapLegacyArtifactPath(path, task.id, current.nodes.clarify!));
      },
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
  const brief = nextArtifactPath('clarify', node, 'artifacts/brief.md');
  await writeFile(join(taskStore.taskDirectory(task.id), path), content ?? `schemaVersion: aiw.handoff/v1\ntaskId: ${task.id}\nnodeId: clarify\nphase: clarify\nrevision: ${node.revision + 1}\nsummary: 已完成需求澄清并形成可追溯交接。\nfacts:\n  - id: FACT-01\n    statement: 已完成退款申请需求的基础澄清。\n    evidence:\n      - path: ${brief}\ndecisions: []\nacceptance: []\nchanges: []\nverification: []\nopenRisks: []\n`, 'utf8');
}

function mapLegacyArtifactPath(path: string, taskId: string, node: NonNullable<ReturnType<typeof createSevenPhaseTask>['nodes']['clarify']>): string {
  const prefix = `.aiw/tasks/${taskId}/artifacts/`;
  if (!path.startsWith(prefix)) return path;
  const declaredPath = `artifacts/${path.slice(prefix.length)}`;
  if (!node.outputs.includes(declaredPath)) return path;
  return `.aiw/tasks/${taskId}/${nextArtifactPath('clarify', node, declaredPath)}`;
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
