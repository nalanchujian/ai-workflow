import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { createTaskStateCommand, TaskStateCommands } from '../../src/cli/task-state-commands.js';
import { TaskFactGuard } from '../../src/services/task-fact-guard.js';
import { TaskStore } from '../../src/services/task-store.js';
import { TaskDecisionService } from '../../src/services/task-decision-service.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';
import { handoffPath, outputPathsForCompletedRun } from '../../src/domain/handoff.js';

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

  it('records every clarify decision and approval in one review', async () => {
    const { store, directory } = await createApprovalTask('clarify');
    await writeDecisionRegister(directory);
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
    await expect(readFile(join(directory, 'decisions', 'DEC-API-01', 'r1.yaml'), 'utf8')).resolves.toContain('optionId: wait-api');
    await expect(readFile(join(directory, 'approvals', 'clarify', 'r1.yaml'), 'utf8')).resolves.toContain('decision: approved');
  });

  it('records a human-written clarify conclusion outside the proposed options', async () => {
    const { store, directory } = await createApprovalTask('clarify');
    await writeDecisionRegister(directory);
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

  it('does not approve a test report when acceptance results still contain blocked items', async () => {
    const { store } = await createApprovalTask('test', { acceptanceStatus: 'blocked' });
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await expect(commands.approve('refund-123', 'test', { note: '查看报告' }))
      .rejects.toThrow('验收结果包含未通过或阻塞项');
    expect((await store.load('refund-123')).nodes.test.status).toBe('awaiting_approval');
  });

  it('records an explicit risk acceptance before closing a blocked test report', async () => {
    const { store, directory } = await createApprovalTask('test', { acceptanceStatus: 'blocked' });
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    const task = await commands.closeWithRisk('refund-123', {
      owner: 'product-owner', reason: '后端接口未就绪，先以已知风险发布。', expiresAt: '2026-09-01T00:00:00.000Z',
    });

    expect(task).toMatchObject({ status: 'completed', deliveryStatus: 'risk_accepted' });
    await expect(readFile(join(directory, 'risk-acceptances', 'test', 'r1.yaml'), 'utf8'))
      .resolves.toContain('owner: product-owner');
  });

  it('requires a machine-readable risk expiry before closing a blocked test report', async () => {
    const { store } = await createApprovalTask('test', { acceptanceStatus: 'blocked' });
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await expect(commands.closeWithRisk('refund-123', {
      owner: 'product-owner', reason: '后端接口未就绪，先以已知风险发布。', expiresAt: '下个版本',
    })).rejects.toThrow('风险到期时间必须为 ISO 8601 时间');
  });

  it('materializes implementation work units automatically when a plan is approved', async () => {
    const { store, directory } = await createApprovalTask('plan');
    await writeFile(join(directory, 'artifacts', 'work-breakdown.yaml'), [
      'schemaVersion: aiw.work-breakdown/v1',
      'units:',
      '  - id: page',
      '    title: 实现页面筛选',
      '    goal: 提供可筛选的列表页面',
      '    allowedPaths:',
      '      - src/pages/links/**',
      '    acceptanceRefs: [AC-01]',
      '    steps: [实现筛选状态]',
      '    verification: [pnpm test -- links]',
      '  - id: export',
      '    title: 实现导出文件名',
      '    goal: 按筛选项生成导出名称',
      '    allowedPaths:',
      '      - src/services/export.ts',
      '    acceptanceRefs: [AC-02]',
      '    steps: [实现文件名生成函数]',
      '    verification: [pnpm test -- export]',
    ].join('\n') + '\n', 'utf8');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    const updated = await commands.approve('refund-123', 'plan', { note: '计划确认' });

    expect(updated.nodes.implement).toMatchObject({ status: 'superseded' });
    expect(updated.nodes['implement-page']).toMatchObject({
      title: '实现页面筛选',
      allowedPaths: ['src/pages/links/**'],
      contextPath: 'artifacts/work-units/r1/implement-page.md',
      status: 'ready',
    });
    expect(updated.nodes['implement-export']).toMatchObject({
      title: '实现导出文件名',
      allowedPaths: ['src/services/export.ts'],
      contextPath: 'artifacts/work-units/r1/implement-export.md',
      status: 'ready',
    });
    expect(updated.nodes.verify.dependsOn).toEqual(['implement-page', 'implement-export']);
    await expect(readFile(join(directory, 'artifacts', 'work-units', 'r1', 'implement-export.md'), 'utf8'))
      .resolves.toContain('src/services/export.ts');
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
              affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] }, status: 'proposed',
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
              affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] }, status: 'proposed',
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

    expect(output).toContain('1. 查看待审批产物：.aiw/tasks/refund-123/artifacts/implementation-plan.md');
    expect(output).toContain('2. aiw task approve refund-123 plan --note "<审批说明>"');
    expect(output).not.toContain('git add .aiw');
    expect(output).not.toContain('若尚未提交');
  });

  it('guides users through every clarify decision and confirms them together', async () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'awaiting_approval';
    let output = '';
    let selections: unknown;
    const answers = ['3', '详情页先复用现有聚合接口，趋势和导出等待下一期。', '1'];
    const command = createTaskStateCommand({
      commands: {
        async status() { return task; },
        async listDecisions() {
          return [{
            item: {
              id: 'DEC-API-01', title: '详情趋势数据来源', type: 'external-contract',
              affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] }, status: 'proposed',
              options: [
                { id: 'wait-api', title: '等待正式 API', tradeoffs: '交付依赖后端排期，但数据口径一致。' },
                { id: 'mock-ui', title: '使用 Mock 验证界面', tradeoffs: '可以提前验证界面，但不能完成端到端验收。' },
              ],
              recommendation: { optionId: 'wait-api', rationale: '当前仓库没有可信详情与趋势接口。' },
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
    expect(output).toContain('原因：当前仓库没有可信详情与趋势接口。');
    expect(output).toContain('推荐\n    1. 等待正式 API');
    expect(output).toContain('备选\n    2. 使用 Mock 验证界面');
    expect(output).toContain('取舍：交付依赖后端排期，但数据口径一致。');
    expect(output).toContain('取舍：可以提前验证界面，但不能完成端到端验收。');
    expect(output).toContain('3. 自定义结论');
    expect(output).toContain('全部事项已处理。是否确认并进入技术方案？');
    expect(selections).toEqual([{
      decisionId: 'DEC-API-01',
      optionId: 'manual',
      manualNote: '详情页先复用现有聚合接口，趋势和导出等待下一期。',
    }]);
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

async function createApprovalTask(nodeId: 'clarify' | 'plan' | 'test', options: { completionBundle?: boolean; acceptanceStatus?: 'passed' | 'blocked' } = {}): Promise<{ store: TaskStore; directory: string }> {
  const directory = await createTempDirectory('aiw-task-state-');
  directories.push(directory);
  const store = new TaskStore(directory);
  const task = createSevenPhaseTask();
  if (nodeId === 'plan') {
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'completed';
  }
  if (nodeId === 'test') {
    for (const id of ['clarify', 'solution', 'plan', 'implement', 'verify']) task.nodes[id]!.status = 'completed';
  }
  task.nodes[nodeId].status = 'awaiting_approval';
  task.nodes[nodeId].revision = 1;
  await store.create(task);
  const taskDirectory = store.taskDirectory(task.id);
  await mkdir(join(taskDirectory, 'artifacts'), { recursive: true });
  const node = task.nodes[nodeId];
  const outputs = outputPathsForCompletedRun(nodeId, node);
  for (const output of outputs) {
    await mkdir(join(taskDirectory, output, '..'), { recursive: true });
    const content = output === handoffPath(nodeId, node.revision)
      ? `schemaVersion: aiw.handoff/v1\ntaskId: ${task.id}\nnodeId: ${nodeId}\nphase: ${node.phase}\nrevision: ${node.revision}\nsummary: 已完成${node.title}并形成结构化交接结论。\nfacts:\n  - id: FACT-01\n    statement: 当前节点已生成声明的工作产物。\n    evidence:\n      - path: ${node.outputs[0]}\ndecisions: []\nacceptance: []\nchanges: []\nverification: []\nopenRisks: []\n`
      : nodeId === 'test' && output === 'artifacts/acceptance-results.yaml'
        ? `schemaVersion: aiw.acceptance-results/v1\nitems:\n  - id: AC-01\n    status: ${options.acceptanceStatus ?? 'passed'}\n    evidence:\n      - artifacts/test-report.md\n`
        : nodeId === 'test' && output === 'artifacts/test-report.md'
          ? '# 测试报告\n\n## 测试命令\n\n`pnpm test`\n\n## 测试结果\n\n已执行。\n'
          : `# ${output}\n`;
    await writeFile(join(taskDirectory, output), content, 'utf8');
  }
  if (options.completionBundle !== false) {
    const runId = `${nodeId}-run-1`;
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

async function writeDecisionRegister(directory: string): Promise<void> {
  await writeFile(join(directory, 'artifacts', 'decision-register.yaml'), `schemaVersion: aiw.decision-register/v1
items:
  - id: DEC-API-01
    title: 详情趋势数据来源
    type: external-contract
    affects:
      acceptanceRefs: [AC-07]
      workUnits: [performance-overview]
    status: proposed
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
