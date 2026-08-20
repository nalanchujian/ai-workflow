import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { createTaskStateCommand, TaskStateCommands } from '../../src/cli/task-state-commands.js';
import { TaskFactGuard } from '../../src/services/task-fact-guard.js';
import { TaskStore } from '../../src/services/task-store.js';
import { TaskDecisionService } from '../../src/services/task-decision-service.js';
import { loadRunCompletionBundle } from '../../src/services/run-completion-bundle.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';
import { completedArtifactPath, handoffPath, outputPathsForCompletedRun } from '../../src/domain/handoff.js';
import { FileTaskRunLock } from '../../src/services/task-run-lock.js';

const directories: string[] = [];

describe('TaskStateCommands', () => {
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('does not expose manual revision or change-request commands', () => {
    const command = createTaskStateCommand({
      commands: {} as never,
      stdout: { write() { return true; } } as unknown as NodeJS.WriteStream,
    });

    expect(command.commands.map((item) => item.name())).not.toContain('revise');
    expect(command.commands.map((item) => item.name())).not.toContain('request-changes');
    expect(command.commands.map((item) => item.name())).not.toContain('fail');

    const decision = command.commands.find((item) => item.name() === 'decision');
    expect(decision?.description()).toContain('高级：');
    expect(decision?.commands.map((item) => item.name())).not.toContain('choose');
    expect(decision?.commands.map((item) => item.name())).not.toContain('wait');
    expect(decision?.commands.map((item) => item.name())).not.toContain('defer');
    expect(decision?.commands.map((item) => item.name())).not.toContain('waive');
    expect(decision?.commands.find((item) => item.name() === 'resolve')?.description()).toContain('例外：');

    expect(command.commands.find((item) => item.name() === 'close-with-risk')?.description()).toContain('例外：');
    expect(command.commands.find((item) => item.name() === 'cancel')?.description()).toContain('例外：');
  });

  it('requires clarify to use the review command', async () => {
    const { store } = await createApprovalTask('clarify');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await expect(commands.approve('refund-123', 'clarify', { note: '验收标准完整' }))
      .rejects.toThrow('需求澄清请使用 aiw task review refund-123');
  });

  it('refuses a state mutation while another command holds the shared task lock', async () => {
    const { store } = await createApprovalTask('plan');
    const before = await store.load('refund-123');
    const runtimeRoot = await createTempDirectory('aiw-task-state-lock-');
    directories.push(runtimeRoot);
    const taskLock = new FileTaskRunLock(runtimeRoot);
    const lease = await taskLock.acquire({ taskId: 'refund-123' });
    const commands = new TaskStateCommands({
      taskStore: store,
      taskLock,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await expect(commands.approve('refund-123', 'plan', { note: '批准实施计划' }))
      .rejects.toThrow('当前任务正在被其他命令修改');
    await lease?.release();
    await expect(store.load('refund-123')).resolves.toMatchObject({ stateVersion: before.stateVersion, nodes: { plan: { status: 'awaiting_approval' } } });
  });

  it('rejects direct clarify approval before checking its run bundle', async () => {
    const { store } = await createApprovalTask('clarify', { completionBundle: false });
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await expect(commands.approve('refund-123', 'clarify', { note: '验收标准完整' }))
      .rejects.toThrow('需求澄清请使用 aiw task review refund-123');
  });

  it('rejects direct clarify approval when decisions are outstanding', async () => {
    const { store, directory } = await createApprovalTask('clarify');
    await writeDecisionRegister(directory);
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
      decisionService: new TaskDecisionService({ taskStore: store }),
    });

    await expect(commands.approve('refund-123', 'clarify', { note: '需求澄清确认' }))
      .rejects.toThrow('需求澄清请使用 aiw task review refund-123');
  });

  it('invalidates an approval stage when an artifact changed after its successful run', async () => {
    const { store, directory } = await createApprovalTask('plan');
    const task = await store.load('refund-123');
    await writeFile(join(directory, completedArtifactPath('plan', task.nodes.plan!, 'artifacts/implementation-plan.md')), '# 被人工改写的实施计划\n', 'utf8');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await expect(commands.approve('refund-123', 'plan', { note: '批准实施计划' }))
      .rejects.toThrow('完成产物哈希不一致');

    const invalidated = await store.load('refund-123');
    expect(invalidated.nodes.plan?.status).toBe('invalidated');
    expect(invalidated.nodes.implement?.status).toBe('invalidated');
    expect(invalidated.approvalRefs).not.toContain('approvals/plan.yaml');
  });

  it('rejects a downstream completion bundle when its approval hashes do not match the completed run', async () => {
    const { store } = await createApprovalTask('plan');
    const task = await store.load('refund-123');
    const plan = task.nodes.plan!;
    plan.status = 'completed';
    task.approvalRefs = ['approvals/plan.yaml'];
    await store.createFact(task.id, 'approvals/plan.yaml', [
      'nodeId: plan',
      'artifactHashes:',
      ...outputPathsForCompletedRun('plan', plan).map((path) => `  ${path}: sha256:${'f'.repeat(64)}`),
      'decision: approved',
      'actor: tech-lead',
      'at: 2026-08-18T00:00:00.000Z',
      '',
    ].join('\n'));
    await store.update(task);

    await expect(loadRunCompletionBundle(await store.load(task.id), store, 'plan'))
      .rejects.toThrow('审批记录与完成运行不一致');
  });

  it('records every clarify decision and approval in one review', async () => {
    const { store, directory } = await createApprovalTask('clarify');
    await writeDecisionRegister(directory);
    await refreshCompletionHashes(store, 'clarify');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
      decisionService: new TaskDecisionService({ taskStore: store }),
    });

    const reviewed = await commands.reviewClarify('refund-123', [{
      decisionId: 'DEC-API-01', optionId: 'wait-api', status: 'waiting_external', owner: 'backend', unblockCondition: '接口契约与联调样例已确认',
    }], { note: '按建议等待后端接口' });

    expect(reviewed.nodes.clarify.status).toBe('completed');
    expect(reviewed.nodes.solution.status).toBe('ready');
    expect(reviewed.decisions).toEqual([expect.objectContaining({ id: 'DEC-API-01', optionId: 'wait-api', status: 'waiting_external', owner: 'backend', actor: 'tech-lead' })]);
    await expect(readFile(join(directory, 'decisions', 'DEC-API-01.yaml'), 'utf8')).resolves.toContain('optionId: wait-api');
    await expect(readFile(join(directory, 'approvals', 'clarify.yaml'), 'utf8')).resolves.toContain('decision: approved');
  });

  it('records a human-written clarify conclusion outside the proposed options', async () => {
    const { store, directory } = await createApprovalTask('clarify');
    await writeDecisionRegister(directory);
    await refreshCompletionHashes(store, 'clarify');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
      decisionService: new TaskDecisionService({ taskStore: store }),
    });

    const reviewed = await commands.reviewClarify('refund-123', [{
      decisionId: 'DEC-API-01', optionId: 'manual', manualNote: '详情页先复用现有聚合接口，趋势和导出等待下一期。',
    }], { note: '需求澄清确认' });

    expect(reviewed.decisions).toEqual([expect.objectContaining({
      id: 'DEC-API-01', optionId: 'manual', note: '详情页先复用现有聚合接口，趋势和导出等待下一期。',
    })]);
  });

  it('selects the quick path only for a fully confirmed single-AC clarification', async () => {
    const { store, directory } = await createApprovalTask('clarify');
    await refreshCompletionHashes(store, 'clarify');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
      decisionService: new TaskDecisionService({ taskStore: store }),
    });

    const reviewed = await commands.reviewClarify('refund-123', [], { workflowPath: 'quick', note: '小范围修复按快速修改推进' });

    expect(reviewed.workflowPath).toMatchObject({ id: 'quick', selectedBy: 'tech-lead' });
    expect(reviewed.nodes.solution).toMatchObject({ status: 'superseded', dependsOn: ['clarify'] });
    expect(reviewed.nodes.plan).toMatchObject({ status: 'ready', dependsOn: ['clarify'] });
    await expect(readFile(join(directory, 'workflow-assessments', 'clarify.yaml'), 'utf8')).resolves.toContain('recommendedPath: quick');
  });

  it('does not allow a decision-bearing clarification to select quick', async () => {
    const { store, directory } = await createApprovalTask('clarify');
    await writeDecisionRegister(directory);
    await refreshCompletionHashes(store, 'clarify');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
      decisionService: new TaskDecisionService({ taskStore: store }),
    });

    await expect(commands.reviewClarify('refund-123', [{ decisionId: 'DEC-API-01', optionId: 'mock-ui' }], { workflowPath: 'quick' }))
      .rejects.toThrow('不满足快速修改条件');
  });

  it('allows a quick task to upgrade to standard before a plan exists', async () => {
    const { store } = await createApprovalTask('clarify');
    await refreshCompletionHashes(store, 'clarify');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
      decisionService: new TaskDecisionService({ taskStore: store }),
    });
    await commands.reviewClarify('refund-123', [], { workflowPath: 'quick' });

    const switched = await commands.switchToStandardPath('refund-123');

    expect(switched.workflowPath?.id).toBe('standard');
    expect(switched.nodes.solution).toMatchObject({ status: 'ready', dependsOn: ['clarify'] });
    expect(switched.nodes.plan).toMatchObject({ status: 'pending', dependsOn: ['solution'] });
  });

  it('does not approve a delivery unit when acceptance results still contain blocked items', async () => {
    const { store } = await createApprovalTask('delivery-main', { acceptanceStatus: 'blocked' });
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await expect(commands.approve('refund-123', 'delivery-main', { note: '查看报告' }))
      .rejects.toThrow('交付单元存在未通过或阻塞验收项');
    expect((await store.load('refund-123')).nodes['delivery-main']?.status).toBe('awaiting_approval');
  });

  it('does not approve a passed AC when its cited test did not actually pass', async () => {
    const { store, directory } = await createApprovalTask('delivery-main');
    const task = await store.load('refund-123');
    const node = task.nodes['delivery-main']!;
    const path = completedArtifactPath('delivery-main', node, 'artifacts/test-results.yaml');
    const evidencePath = 'runs/delivery-main-run-1/tests/TEST-REFUND-01.json';
    const evidence = JSON.stringify({ schemaVersion: 'aiw.test-execution-evidence/v1', runId: 'delivery-main-run-1', testId: 'TEST-REFUND-01', command: 'pnpm test', status: 'failed', exitCode: 1 }, null, 2) + '\n';
    await writeFile(join(directory, evidencePath), evidence, 'utf8');
    await writeFile(join(directory, path), `schemaVersion: aiw.test-results/v2\nrunId: delivery-main-run-1\nitems:\n  - id: TEST-REFUND-01\n    profile: vitest\n    evidenceType: unit\n    acceptanceRefs: [AC-01]\n    command: pnpm test\n    status: failed\n    exitCode: 1\n    summary: 已执行退款功能测试，但存在失败用例。\n    evidencePath: ${evidencePath}\n    evidenceSha256: ${createHash('sha256').update(evidence).digest('hex')}\n`, 'utf8');
    await refreshCompletionHashes(store, 'delivery-main');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await expect(commands.approve('refund-123', 'delivery-main', { note: '查看报告' }))
      .rejects.toThrow('实际通过且退出码为 0');
    expect((await store.load('refund-123')).nodes['delivery-main']?.status).toBe('awaiting_approval');
  });

  it('invalidates a delivery unit when its AIW test execution evidence was modified', async () => {
    const { store, directory } = await createApprovalTask('delivery-main');
    await writeFile(join(directory, 'runs/delivery-main-run-1/tests/TEST-REFUND-01.json'), '{"tampered":true}\n', 'utf8');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await expect(commands.approve('refund-123', 'delivery-main', { note: '查看报告' }))
      .rejects.toThrow('测试执行证据哈希不一致');
    expect((await store.load('refund-123')).nodes['delivery-main']?.status).toBe('invalidated');
  });

  it('records an explicit risk acceptance before closing a blocked delivery unit', async () => {
    const { store, directory } = await createApprovalTask('delivery-main', { acceptanceStatus: 'blocked' });
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    const task = await commands.closeWithRisk('refund-123', 'delivery-main', {
      owner: 'product-owner', reason: '后端接口未就绪，先以已知风险发布。', expiresAt: '2026-09-01T00:00:00.000Z',
    });

    expect(task).toMatchObject({ status: 'completed', deliveryStatus: 'risk_accepted' });
    await expect(readFile(join(directory, 'risk-acceptances', 'delivery-main.yaml'), 'utf8'))
      .resolves.toContain('owner: product-owner');
  });

  it('requires a machine-readable risk expiry before closing a blocked delivery unit', async () => {
    const { store } = await createApprovalTask('delivery-main', { acceptanceStatus: 'blocked' });
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await expect(commands.closeWithRisk('refund-123', 'delivery-main', {
      owner: 'product-owner', reason: '后端接口未就绪，先以已知风险发布。', expiresAt: '下个版本',
    })).rejects.toThrow('风险到期时间必须为 ISO 8601 时间');
  });

  it('materializes implementation work units automatically when a plan is approved', async () => {
    const { store, directory } = await createApprovalTask('plan');
    const task = await store.load('refund-123');
    await writeFile(join(directory, completedArtifactPath('plan', task.nodes.plan!, 'artifacts/work-breakdown.yaml')), [
      'schemaVersion: aiw.work-breakdown/v2',
      'units:',
      '  - id: page',
      '    title: 实现页面筛选',
      '    goal: 提供可筛选的列表页面',
      '    acceptanceRefs: [AC-01]',
      '    factRefs: [FACT-REFUND-01]',
      '    decisionRefs: []',
      '    steps: [实现筛选状态]',
      '    verification: [{ profile: vitest, targets: [links], evidenceType: component, acceptanceRefs: [AC-01] }]',
      '  - id: export',
      '    title: 实现导出文件名',
      '    goal: 按筛选项生成导出名称',
      '    acceptanceRefs: [AC-02]',
      '    factRefs: [FACT-REFUND-01]',
      '    decisionRefs: []',
      '    steps: [实现文件名生成函数]',
      '    verification: [{ profile: vitest, targets: [export], evidenceType: unit, acceptanceRefs: [AC-02] }]',
      'acceptanceCoverage:',
      '  - acceptanceId: AC-01',
      '    disposition: implement',
      '    workUnitIds: [page]',
      '  - acceptanceId: AC-02',
      '    disposition: implement',
      '    workUnitIds: [export]',
    ].join('\n') + '\n', 'utf8');
    await refreshCompletionHashes(store, 'plan');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    const updated = await commands.approve('refund-123', 'plan', { note: '计划确认' });

    expect(updated.nodes.implement).toMatchObject({ status: 'superseded' });
    expect(updated.nodes['delivery-page']).toMatchObject({
      title: '实现页面筛选',
      contextPath: 'artifacts/work-units/delivery-page.md',
      status: 'ready',
    });
    expect(updated.nodes['delivery-export']).toMatchObject({
      title: '实现导出文件名',
      contextPath: 'artifacts/work-units/delivery-export.md',
      status: 'ready',
    });
    expect(updated.impactGraph).toMatchObject({ path: 'impact-graphs/plan.yaml' });
    await expect(readFile(join(directory, 'artifacts', 'work-units', 'delivery-export.md'), 'utf8'))
      .resolves.toContain('实现导出文件名');
    await expect(readFile(join(directory, 'impact-graphs', 'plan.yaml'), 'utf8'))
      .resolves.toContain('delivery-export');
  });

  it('rejects plan approval when an acceptance item is not covered by work or an explicit decision', async () => {
    const { store, directory } = await createApprovalTask('plan');
    const task = await store.load('refund-123');
    await writeFile(join(directory, completedArtifactPath('plan', task.nodes.plan!, 'artifacts/work-breakdown.yaml')), [
      'schemaVersion: aiw.work-breakdown/v2',
      'units:',
      '  - id: page',
      '    title: 实现页面筛选',
      '    goal: 提供可筛选的列表页面',
      '    acceptanceRefs: [AC-01]',
      '    factRefs: [FACT-REFUND-01]',
      '    decisionRefs: []',
      '    steps: [实现筛选状态]',
      '    verification: [{ profile: vitest, targets: [links], evidenceType: component, acceptanceRefs: [AC-01] }]',
      'acceptanceCoverage:',
      '  - acceptanceId: AC-01',
      '    disposition: implement',
      '    workUnitIds: [page]',
    ].join('\n') + '\n', 'utf8');
    await refreshCompletionHashes(store, 'plan');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await expect(commands.approve('refund-123', 'plan', { note: '计划确认' }))
      .rejects.toThrow('未声明覆盖方式：AC-02');
    expect((await store.load('refund-123')).nodes.plan.status).toBe('awaiting_approval');
    await expect(readFile(join(directory, 'approvals', 'plan.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('guides a waiting approval through review, commit, and approval in task status', async () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'awaiting_approval';
    let output = '';
    const command = createTaskStateCommand({
      commands: {
        async status() { return task; },
        async uncommittedTaskPaths() { return ['.aiw/tasks/refund-123/task.yaml']; },
        async listDecisions() {
          return [{
            item: {
              id: 'DEC-API-01', title: '详情趋势数据来源', type: 'external-contract',
              affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] },
              options: [
                { id: 'wait-api', title: '等待正式 API', tradeoffs: '交付依赖后端排期，但数据口径一致。' },
                { id: 'mock-ui', title: '使用 Mock 验证界面', tradeoffs: '可以提前验证界面，但不能完成端到端验收。' },
              ],
              recommendation: { optionId: 'wait-api', rationale: '当前仓库没有可信详情与趋势接口。' },
            },
          }];
        },
      } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'task', 'status', 'refund-123']);

    expect(output).toContain('1. 查看待审批产物：.aiw/tasks/refund-123/artifacts/brief.md');
    expect(output).toContain('2. git add .aiw && git commit -m "chore(aiw): record clarify result"');
    expect(output).toContain('待确认事项（1 项）');
    expect(output).toContain('DEC-API-01：详情趋势数据来源（建议：等待正式 API）');
    expect(output).toContain('3. aiw task review refund-123');
    expect(output).not.toContain('aiw task approve refund-123 clarify');
  });

  it('does not suggest a Git commit when pending clarify facts are already committed', async () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'awaiting_approval';
    let output = '';
    const command = createTaskStateCommand({
      commands: {
        async status() { return task; },
        async uncommittedTaskPaths() { return []; },
        async listDecisions() {
          return [{
            item: {
              id: 'DEC-API-01', title: '详情趋势数据来源', type: 'external-contract',
              affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] },
              options: [{ id: 'wait-api', title: '等待正式 API', tradeoffs: '依赖后端排期。' }, { id: 'mock-ui', title: '使用 Mock 验证界面', tradeoffs: '不能完成端到端验收。' }],
              recommendation: { optionId: 'wait-api', rationale: '当前仓库没有可信详情接口。' },
            },
          }];
        },
      } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'task', 'status', 'refund-123']);

    expect(output).toContain('1. 查看待审批产物');
    expect(output).toContain('2. aiw task review refund-123');
    expect(output).not.toContain('git add .aiw');
  });

  it('does not suggest a Git commit when a pending non-clarify approval is already committed', async () => {
    const task = createSevenPhaseTask();
    task.nodes.plan.status = 'awaiting_approval';
    let output = '';
    const command = createTaskStateCommand({
      commands: {
        async status() { return task; },
        async uncommittedTaskPaths() { return []; },
        async listDecisions() { return []; },
      } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'task', 'status', 'refund-123']);

    expect(output).toContain('1. 查看待审批产物：.aiw/tasks/refund-123/artifacts/plan/implementation-plan.md');
    expect(output).toContain('2. aiw task approve refund-123 plan --note "<审批说明>"');
    expect(output).not.toContain('git add .aiw');
    expect(output).not.toContain('若尚未提交');
  });

  it('guides a cancelled node through committing evidence and rerunning the same command', async () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'cancelled';
    let output = '';
    const command = createTaskStateCommand({
      commands: {
        async status() { return task; },
        async uncommittedTaskPaths() { return ['.aiw/tasks/refund-123/task.yaml']; },
        async listDecisions() { return []; },
      } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'task', 'status', 'refund-123']);

    expect(output).toContain('git add .aiw && git commit -m "chore(aiw): record clarify cancellation"');
    expect(output).toContain('重新执行「澄清需求」：aiw task run refund-123 clarify');
  });

  it('guides users through every clarify decision and confirms them together', async () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'awaiting_approval';
    let output = '';
    let selections: unknown;
    const answers = ['1', '2', '1'];
    const command = createTaskStateCommand({
      commands: {
        async status() { return task; },
        async listDecisions() {
          return [{
            item: {
              id: 'DEC-API-01', title: '详情趋势数据来源', type: 'external-contract',
              detail: {
                question: '详情趋势页面本期使用哪一套数据接口？',
                background: '当前仓库没有可覆盖趋势、导出与日期粒度的统一接口。',
                impact: '不先确认会导致页面交互和最终验收使用不同的数据口径。',
              },
              affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] },
              options: [
                { id: 'use-existing-api', title: '复用现有聚合接口', tradeoffs: '可以立即实施，但需要限制为现有字段能力。' },
                { id: 'mock-ui', title: '使用 Mock 验证界面', tradeoffs: '可以提前验证界面，但不能完成端到端验收。' },
              ],
              recommendation: { optionId: 'use-existing-api', rationale: '当前仓库已有可复用聚合接口，适合先完成本期交互。' },
            },
          }];
        },
        async reviewClarify(_taskId: string, received: unknown) {
          selections = received;
          return task;
        },
      } as never,
      reviewPrompter: { async ask() { return answers.shift() ?? ''; } },
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'task', 'review', 'refund-123']);

    expect(output).toContain('需求澄清 · 待确认 1 项');
    expect(output).toContain('[1/1] 详情趋势数据来源');
    expect(output).toContain('本期如何处理');
    expect(output).toContain('1. 本期继续');
    expect(output).toContain('2. 等待外部条件');
    expect(output).toContain('本期采用什么结论');
    expect(output).toContain('1. 复用现有聚合接口（AI 推荐）');
    expect(output).toContain('2. 使用 Mock 验证界面（AI 备选）');
    expect(output).toContain('取舍：可以提前验证界面，但不能完成端到端验收。');
    expect(output).toContain('3. 人工输入结论');
    expect(output).toContain('工作方式建议');
    expect(output).toContain('全部事项已处理。将按「标准需求」推进。是否确认？');
    expect(selections).toEqual([{
      decisionId: 'DEC-API-01',
      optionId: 'mock-ui',
      status: 'resolved',
    }]);
  });

  it('shows decision context before choosing a workflow outcome', async () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'awaiting_approval';
    let selections: unknown;
    const answers = ['2', '1'];
    let output = '';
    const command = createTaskStateCommand({
      commands: {
        async status() { return task; },
        async listDecisions() {
          return [{
            item: {
              id: 'DEC-METRIC-01', title: 'Custom metrics 的配置规则', type: 'business-rule',
              detail: {
                question: '用户可以选择哪些指标，以及刷新页面后是否保留选择？',
                background: '需求只说明新增 Custom metrics，未说明字段白名单、默认顺序和持久化规则。',
                impact: '不确认会使列表展示和导出字段采用不同规则，造成返工和验收争议。',
              },
              affects: { acceptanceRefs: ['AC-01'], workUnits: ['list-custom-metrics'] },
              options: [
                { id: 'product-rule', title: '采用产品给定指标规则', tradeoffs: '规则准确，但必须由人工在本次确认中补充具体规则。' },
                { id: 'use-existing', title: '沿用现有列表列', tradeoffs: '可以立即开发，但可能与本期规则不一致。' },
              ],
              recommendation: { optionId: 'product-rule', rationale: '当前需求没有足以锁定配置规则的证据。' },
            },
          }];
        },
        async acceptanceDetails() {
          return new Map([
            ['AC-01', {
              id: 'AC-01', title: 'Custom metrics 配置',
              description: '用户可以配置允许展示的指标，并在刷新或切换 Creator 后保留选择。',
            }],
          ]);
        },
        async reviewClarify(_taskId: string, received: unknown) { selections = received; return task; },
      } as never,
      reviewPrompter: { async ask() { return answers.shift() ?? ''; } },
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'task', 'review', 'refund-123']);

    expect(output).toContain('待确认：用户可以选择哪些指标，以及刷新页面后是否保留选择？');
    expect(output).toContain('当前情况：需求只说明新增 Custom metrics，未说明字段白名单、默认顺序和持久化规则。');
    expect(output).toContain('不确认的影响：不确认会使列表展示和导出字段采用不同规则，造成返工和验收争议。');
    expect(output).toContain('关联验收项：AC-01：Custom metrics 配置');
    expect(output).toContain('AC-01：Custom metrics 配置');
    expect(output).toContain('验收标准：用户可以配置允许展示的指标，并在刷新或切换 Creator 后保留选择。');
    expect(selections).toEqual([{ decisionId: 'DEC-METRIC-01', optionId: 'manual', status: 'waiting_external', owner: '待指定', unblockCondition: '已确认：Custom metrics 的配置规则', manualNote: '人工选择等待外部条件。' }]);
  });

  it('uses the generic wait outcome instead of exposing scope changes as options', async () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'awaiting_approval';
    let selections: unknown;
    const prompts: string[] = [];
    const answers = ['2', '1'];
    const command = createTaskStateCommand({
      commands: {
        async status() { return task; },
        async listDecisions() {
          return [{
            item: {
              id: 'DEC-API-01', title: '详情趋势数据来源', type: 'external-contract',
              affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] },
              options: [
                { id: 'formal-api', title: '采用正式 API', tradeoffs: '数据口径可联调验收，但需要补齐字段契约。' },
                { id: 'mock-ui', title: '采用 Mock 验证界面', tradeoffs: '可以先验证界面，但不能证明正式接口已通过。' },
              ],
              recommendation: { optionId: 'formal-api', rationale: '当前仓库没有可信详情与趋势接口。' },
            },
          }];
        },
        async reviewClarify(_taskId: string, received: unknown) {
          selections = received;
          return task;
        },
      } as never,
      reviewPrompter: { async ask(prompt: string) { prompts.push(prompt); return answers.shift() ?? ''; } },
      stdout: { write() { return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'task', 'review', 'refund-123']);

    expect(prompts).toContain('请输入选择（1-2）：');
    expect(prompts).not.toContain('请输入拆期说明：');
    expect(selections).toEqual([{
      decisionId: 'DEC-API-01', optionId: 'manual', status: 'waiting_external',
      owner: '待指定', unblockCondition: '已确认：详情趋势数据来源', manualNote: '人工选择等待外部条件。',
    }]);
  });

  it('lets a user choose quick or standard only when the assessment is eligible', async () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'awaiting_approval';
    task.nodes.clarify.hasResult = true;
    const answers = ['1', '1'];
    let receivedOptions: unknown;
    let output = '';
    const command = createTaskStateCommand({
      commands: {
        async status() { return task; },
        async listDecisions() { return []; },
        async assessWorkflowPath() {
          return {
            schemaVersion: 'aiw.workflow-path-assessment/v1', taskId: task.id, policyVersion: 'quick-standard/v1', recommendedPath: 'quick',
            signals: { sourceCount: 1, sourceCharacters: 320, acceptanceCount: 1, decisionCount: 0, confirmedFactCount: 2, nonConfirmedFactCount: 0 },
            quick: { eligible: true, reasons: [] }, evaluatedAt: '2026-08-19T00:00:00.000Z',
          };
        },
        async reviewClarify(_taskId: string, _selections: unknown, options: unknown) { receivedOptions = options; return task; },
      } as never,
      reviewPrompter: { async ask() { return answers.shift() ?? ''; } },
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'task', 'review', 'refund-123']);

    expect(output).toContain('AI 建议：快速修改');
    expect(output).toContain('1. 快速修改');
    expect(output).toContain('2. 标准需求');
    expect(receivedOptions).toMatchObject({ workflowPath: 'quick' });
  });

  it('does not prompt again when clarify was already approved', async () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'ready';
    let output = '';
    const command = createTaskStateCommand({
      commands: {
        async status() { return task; },
        async listDecisions() { throw new Error('不应读取决策'); },
      } as never,
      reviewPrompter: { async ask() { throw new Error('不应要求输入'); } },
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'task', 'review', 'refund-123']);

    expect(output).toContain('需求澄清已确认，无需再次操作');
    expect(output).toContain('aiw task run refund-123 solution');
    expect(output).not.toContain('aiw task status refund-123');
  });

});

async function createApprovalTask(nodeId: 'clarify' | 'plan' | 'delivery-main', options: { completionBundle?: boolean; acceptanceStatus?: 'passed' | 'blocked' } = {}): Promise<{ store: TaskStore; directory: string }> {
  const directory = await createTempDirectory('aiw-task-state-');
  directories.push(directory);
  const store = new TaskStore(directory);
  const task = createSevenPhaseTask();
  task.sources.requirements = {
    kind: 'local-file',
    origin: 'requirements.md',
    revision: 1,
    snapshotPath: 'sources/requirements/r1/snapshot.md',
    metaPath: 'sources/requirements/r1/meta.json',
    contentSha256: 'a'.repeat(64),
  };
  if (nodeId === 'plan') {
    task.nodes.clarify = { ...task.nodes.clarify, status: 'completed', hasResult: true };
    task.nodes.solution.status = 'completed';
  }
  if (nodeId === 'delivery-main') {
    for (const id of ['clarify', 'solution', 'plan']) task.nodes[id]!.status = 'completed';
    task.nodes.implement.status = 'superseded';
    task.nodes['delivery-main'] = {
      ...task.nodes.implement,
      title: '完成退款功能',
      status: 'awaiting_approval',
      dependsOn: ['plan'],
      generatedFromPlan: true,
      workUnitId: 'main',
      acceptanceRefs: ['AC-01'],
      decisionRefs: [],
      verificationPlan: [{ id: 'TEST-REFUND-01', profile: 'vitest', evidenceType: 'unit', acceptanceRefs: ['AC-01'], command: 'pnpm test' }],
    };
  }
  task.nodes[nodeId]!.status = 'awaiting_approval';
  task.nodes[nodeId]!.hasResult = true;
  await store.create(task);
  await writeFile(join(directory, '.aiw', 'config.yaml'), `schemaVersion: aiw.config/v1
testing:
  profiles:
    - id: vitest
      title: 项目测试
      command: pnpm exec vitest run
      healthCheck: pnpm exec vitest --version
      targetMode: append
      evidenceTypes: [unit, component]
`, 'utf8');
  const taskDirectory = store.taskDirectory(task.id);
  await mkdir(join(taskDirectory, 'sources', 'requirements', 'r1'), { recursive: true });
  await writeFile(join(taskDirectory, 'sources', 'requirements', 'r1', 'snapshot.md'), '# 退款需求\n\n用户可以提交退款申请并查看处理结果。\n', 'utf8');
  await writeFile(join(taskDirectory, 'sources', 'requirements', 'r1', 'meta.json'), '{}\n', 'utf8');
  await mkdir(join(taskDirectory, 'artifacts'), { recursive: true });
  if (nodeId === 'plan') {
    const acceptancePath = completedArtifactPath('clarify', task.nodes.clarify!, 'artifacts/acceptance.yaml');
    await mkdir(join(taskDirectory, acceptancePath, '..'), { recursive: true });
    await writeFile(join(taskDirectory, acceptancePath), [
      'schemaVersion: aiw.acceptance-catalog/v2',
      'items:',
      '  - id: AC-01',
      '    title: 页面筛选',
      '    description: 用户可以按筛选条件查看列表页面。',
      '    factRefs: [FACT-REFUND-01]',
      '    evidenceType: component',
      '  - id: AC-02',
      '    title: 导出文件名',
      '    description: 用户可以按筛选条件获取符合规则的导出文件名。',
      '    factRefs: [FACT-REFUND-01]',
      '    evidenceType: unit',
    ].join('\n') + '\n', 'utf8');
    const factPath = completedArtifactPath('clarify', task.nodes.clarify!, 'artifacts/fact-register.yaml');
    const decisionPath = completedArtifactPath('clarify', task.nodes.clarify!, 'artifacts/decision-register.yaml');
    await writeFile(join(taskDirectory, factPath), [
      'schemaVersion: aiw.fact-register/v1',
      'items:',
      '  - id: FACT-REFUND-01',
      '    kind: confirmed',
      '    statement: 用户可以通过页面筛选列表并按当前筛选导出文件。',
      '    confidence: high',
      '    evidence:',
      '      - sourceId: requirements',
      '        path: sources/requirements/r1/snapshot.md',
    ].join('\n') + '\n', 'utf8');
    await writeFile(join(taskDirectory, decisionPath), 'schemaVersion: aiw.decision-register/v1\nitems: []\n', 'utf8');
  }
  const node = task.nodes[nodeId];
  const outputs = outputPathsForCompletedRun(nodeId, node);
  const runId = `${nodeId}-run-1`;
  const testEvidencePath = `runs/${runId}/tests/TEST-REFUND-01.json`;
  const testEvidenceContent = JSON.stringify({
    schemaVersion: 'aiw.test-execution-evidence/v1', runId, testId: 'TEST-REFUND-01', command: 'pnpm test', status: 'passed', exitCode: 0, stdout: '', stderr: '', signal: null, timedOut: false,
  }, null, 2) + '\n';
  const testEvidenceSha256 = createHash('sha256').update(testEvidenceContent).digest('hex');
  for (const output of outputs) {
    await mkdir(join(taskDirectory, output, '..'), { recursive: true });
    const firstArtifact = outputs.find((path) => path.startsWith('artifacts/'))!;
    const content = output === handoffPath(nodeId)
      ? `schemaVersion: aiw.handoff/v1\ntaskId: ${task.id}\nnodeId: ${nodeId}\nphase: ${node.phase}\nsummary: 已完成${node.title}并形成结构化交接结论。\nfacts:\n  - id: FACT-REFUND-01\n    statement: 当前节点已生成声明的工作产物。\n    evidence:\n      - path: ${firstArtifact}\ndecisions: []\nacceptance: []\nchanges: []\nverification: []\nopenRisks: []\n`
      : nodeId === 'delivery-main' && output.endsWith('/acceptance-intent.yaml')
        ? `schemaVersion: aiw.acceptance-intent/v2\nitems:\n  - id: AC-01\n    evidence:\n      - artifacts/delivery.md\n`
      : nodeId === 'delivery-main' && output.endsWith('/acceptance-results.yaml')
        ? `schemaVersion: aiw.acceptance-results/v2\nitems:\n  - id: AC-01\n    status: ${options.acceptanceStatus ?? 'passed'}\n    evidenceType: unit\n    evidence:\n      - artifacts/delivery.md\n    testResultRefs: ${options.acceptanceStatus === undefined || options.acceptanceStatus === 'passed' ? '[TEST-REFUND-01]' : '[]'}\n`
      : nodeId === 'delivery-main' && output.endsWith('/test-results.yaml')
        ? `schemaVersion: aiw.test-results/v2\nrunId: ${runId}\nitems:\n  - id: TEST-REFUND-01\n    profile: vitest\n    evidenceType: unit\n    acceptanceRefs: [AC-01]\n    command: pnpm test\n    status: passed\n    exitCode: 0\n    summary: 已执行退款功能测试，目标用例均通过。\n    evidencePath: ${testEvidencePath}\n    evidenceSha256: ${testEvidenceSha256}\n`
      : nodeId === 'delivery-main' && output.endsWith('/delivery.md')
          ? '# 交付报告\n\n## 实际变更\n\n已完成。\n\n## 工程验证\n\n类型检查通过。\n\n## 测试计划\n\nTEST-REFUND-01：`pnpm test`\n\n## 逐项验收\n\nAC-01 等待 AIW 测试执行结果确认。\n\n## 未完成事项与风险\n\n无。\n'
      : nodeId === 'clarify' && output.endsWith('/acceptance.yaml')
            ? 'schemaVersion: aiw.acceptance-catalog/v2\nitems:\n  - id: AC-01\n    title: 退款申请\n    description: 用户可以提交退款申请并查看处理结果。\n    factRefs: [FACT-REFUND-01]\n    evidenceType: unit\n'
            : nodeId === 'clarify' && output.endsWith('/fact-register.yaml')
              ? 'schemaVersion: aiw.fact-register/v1\nitems:\n  - id: FACT-REFUND-01\n    kind: confirmed\n    statement: 用户能够提交退款申请并查看退款处理结果。\n    confidence: high\n    evidence:\n      - sourceId: requirements\n        path: sources/requirements/r1/snapshot.md\n'
            : nodeId === 'clarify' && output.endsWith('/decision-register.yaml')
              ? 'schemaVersion: aiw.decision-register/v1\nitems: []\n'
          : `# ${output}\n`;
    await writeFile(join(taskDirectory, output), content, 'utf8');
  }
  if (options.completionBundle !== false) {
    if (nodeId === 'delivery-main') {
      await store.createFact(task.id, testEvidencePath, testEvidenceContent);
    }
    task.events.push({
      type: 'succeed', nodeId, at: '2026-08-14T00:00:00.000Z', runId,
      outputs: await Promise.all(outputs.map(async (path) => ({ path, sha256: createHash('sha256').update(await readFile(join(taskDirectory, path))).digest('hex') }))),
      evidencePath: `runs/${runId}/change-evidence.json`,
    });
    await store.update(task);
    for (const path of ['context-manifest.json', 'change-baseline.json', 'change-scope.json', 'change-evidence.json', 'change-diff.json', 'change.patch', 'result.json']) {
      await store.createFact('refund-123', `runs/${runId}/${path}`, '{}\n');
    }
  }
  return { store, directory: taskDirectory };
}

async function refreshCompletionHashes(store: TaskStore, nodeId: string): Promise<void> {
  const task = await store.load('refund-123');
  const event = [...task.events].reverse().find((item) => item.type === 'succeed' && item.nodeId === nodeId);
  if (event?.outputs === undefined) throw new Error('测试夹具缺少完成事件');
  event.outputs = await Promise.all(event.outputs.map(async ({ path }) => ({
    path,
    sha256: createHash('sha256').update(await readFile(join(store.taskDirectory(task.id), path))).digest('hex'),
  })));
  await store.update(task);
}

async function writeDecisionRegister(directory: string): Promise<void> {
  await mkdir(join(directory, 'artifacts', 'clarify'), { recursive: true });
  await writeFile(join(directory, 'artifacts', 'clarify', 'decision-register.yaml'), `schemaVersion: aiw.decision-register/v1
items:
  - id: DEC-API-01
    title: 详情趋势数据来源
    detail:
      question: 详情趋势与导出本期使用哪一套服务端接口？
      background: 当前需求与仓库未提供趋势、导出和日期聚合的统一契约。
      impact: 不确认会使页面、导出与验收采用不同的数据口径。
    type: external-contract
    factRefs: [FACT-REFUND-01]
    affects:
      acceptanceRefs: [AC-01]
      workUnits: [performance-overview]
    options:
      - id: wait-api
        title: 等待正式 API
        tradeoffs: 交付依赖后端排期，但数据口径一致。
      - id: mock-ui
        title: 使用 Mock 验证界面
        tradeoffs: 可以提前验证界面，但不能完成端到端验收。
    recommendation:
      optionId: wait-api
      rationale: 当前仓库没有可信详情与趋势接口。
`, 'utf8');
}
