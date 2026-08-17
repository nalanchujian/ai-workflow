import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

import { createTaskStateCommand, TaskStateCommands } from '../../src/cli/task-state-commands.js';
import { TaskFactGuard } from '../../src/services/task-fact-guard.js';
import { TaskStore } from '../../src/services/task-store.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
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
  });

  it('writes an approval bound to the current output hashes before unlocking the downstream node', async () => {
    const { store, directory } = await createApprovalTask('clarify');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await commands.approve('refund-123', 'clarify', { note: '验收标准完整' });

    const approval = parse(await readFile(join(directory, 'approvals', 'clarify', 'r1.yaml'), 'utf8'));
    expect(approval).toMatchObject({ decision: 'approved', actor: 'tech-lead', nodeId: 'clarify', nodeRevision: 1 });
    expect(approval.artifactHashes).toMatchObject({ 'artifacts/brief.md': `sha256:${createHash('sha256').update('# artifacts/brief.md\n').digest('hex')}` });
    expect((await store.load('refund-123')).nodes.solution.status).toBe('ready');
  });

  it('rejects approval when the node has no complete run evidence package', async () => {
    const { store } = await createApprovalTask('clarify', { completionBundle: false });
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await expect(commands.approve('refund-123', 'clarify', { note: '验收标准完整' }))
      .rejects.toThrow('缺少可提交的完成运行包');
  });

  it('requires outstanding clarify decisions to be reviewed before approval', async () => {
    const { store, directory } = await createApprovalTask('clarify');
    await writeDecisionRegister(directory);
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
      decisionService: new TaskDecisionService({ taskStore: store }),
    });

    await expect(commands.approve('refund-123', 'clarify', { note: '需求澄清确认' }))
      .rejects.toThrow('需求澄清仍有待确认项：DEC-API-01；请运行 aiw task review refund-123');
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

  it('marks an interrupted running node as failed with an auditable reason', async () => {
    const { store } = await createApprovalTask('clarify');
    const task = await store.load('refund-123');
    task.nodes.clarify.status = 'running';
    await store.update(task);
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'developer'; } } }),
    });

    await commands.fail('refund-123', 'clarify', { note: 'Codex CLI 参数冲突导致进程中断' });

    const failed = await store.load('refund-123');
    expect(failed.nodes.clarify.status).toBe('failed');
    expect(failed.events.at(-1)).toMatchObject({ type: 'fail', nodeId: 'clarify', actor: 'developer', reason: 'Codex CLI 参数冲突导致进程中断' });
  });

  it('rejects a skill rebind when the installed skill does not support the target phase', async () => {
    const { store, directory } = await createApprovalTask('plan');
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    await registry.replace({
      skills: [{
        name: 'clarify-only', version: '1.0.0', description: 'clarify only', phases: ['clarify'], body: '# skill', registrySource: { url: 'https://example.test/skills.git', revision: 'abc123' }, sha256: 'a'.repeat(64), methodSources: [],
      }],
      profiles: [],
    });
    const task = await store.load('refund-123');
    task.nodes.plan.status = 'ready';
    await store.update(task);
    const commands = new TaskStateCommands({ taskStore: store, taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; } } }), skillRegistry: registry });

    await expect(commands.rebindSkill('refund-123', 'plan', { skill: 'clarify-only@1.0.0', note: '错误映射' }))
      .rejects.toThrow('技能与节点阶段不兼容');
  });

  it('adds an implementation subtask with explicit dependency, approval and verify merge edge', async () => {
    const { store } = await createApprovalTask('plan');
    const task = await store.load('refund-123');
    task.nodes.plan.status = 'completed';
    task.nodes.implement.status = 'pending';
    task.nodes.verify.status = 'pending';
    await store.update(task);
    const commands = new TaskStateCommands({ taskStore: store, taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; } } }) });

    const updated = await commands.addSubtask('refund-123', 'implement-export', {
      title: '实现导出文件名', dependsOn: ['plan'], before: ['verify'], allowedPaths: ['src/services/export.ts'], requiresApproval: true,
    });

    expect(updated.nodes['implement-export']).toMatchObject({ phase: 'implement', dependsOn: ['plan'], status: 'ready', requiresApproval: true, outputs: ['artifacts/subtasks/implement-export.md'], allowedPaths: ['src/services/export.ts'] });
    expect(updated.nodes.verify.dependsOn).toEqual(['implement', 'implement-export']);
    expect(updated.events.at(-1)).toMatchObject({ type: 'add_subtask', nodeId: 'implement-export' });
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

    expect(updated.nodes.implement).toMatchObject({
      title: '实现页面筛选',
      allowedPaths: ['src/pages/links/**'],
      contextPath: 'artifacts/work-units/r1/implement.md',
      status: 'ready',
    });
    expect(updated.nodes['implement-export']).toMatchObject({
      title: '实现导出文件名',
      allowedPaths: ['src/services/export.ts'],
      contextPath: 'artifacts/work-units/r1/implement-export.md',
      status: 'ready',
    });
    expect(updated.nodes.verify.dependsOn).toEqual(['implement', 'implement-export']);
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
    expect(output).toContain('2. 若尚未提交当前产物和状态：git add .aiw && git commit -m "chore(aiw): record clarify result"');
    expect(output).toContain('需求澄清待确认（1 项）');
    expect(output).toContain('DEC-API-01：详情趋势数据来源；AI 建议：等待正式 API');
    expect(output).toContain('3. aiw task review refund-123');
    expect(output).not.toContain('aiw task approve refund-123 clarify');
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

    expect(output).toContain('需求澄清需要确认（1 项）');
    expect(output).toContain('AI 建议：等待正式 API');
    expect(output).toContain('为什么需要确认：当前仓库没有可信详情与趋势接口。');
    expect(output).toContain('取舍：交付依赖后端排期，但数据口径一致。');
    expect(output).toContain('取舍：可以提前验证界面，但不能完成端到端验收。');
    expect(output).toContain('3. 输入其他处理结论');
    expect(output).toContain('是否确认本次需求澄清并进入技术方案阶段？');
    expect(selections).toEqual([{
      decisionId: 'DEC-API-01',
      optionId: 'manual',
      manualNote: '详情页先复用现有聚合接口，趋势和导出等待下一期。',
    }]);
  });

  it('does not prompt again when clarify was already approved', async () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
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
    expect(output).toContain('aiw task status refund-123');
  });

  it('guides users to commit migrated handoffs before continuing the ready node', async () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'completed';
    task.nodes.plan.status = 'completed';
    task.nodes.implement.status = 'completed';
    task.nodes.verify.status = 'completed';
    task.nodes.verify.revision = 1;
    task.nodes.test.status = 'ready';
    let output = '';
    const command = createTaskStateCommand({
      commands: {
        async migrateHandoffs() {
          return {
            task,
            migration: {
              taskId: task.id, migrationId: 'migration-1', migratedNodeIds: ['clarify', 'verify'], skippedNodeIds: ['intake'],
              auditPaths: ['migrations/handoffs/migration-1/clarify.json'],
            },
          };
        },
      } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'task', 'migrate-handoffs', 'refund-123']);

    expect(output).toContain('已补齐结构化交接包');
    expect(output).toContain('已迁移节点：clarify、verify');
    expect(output).toContain('1. git add .aiw && git commit -m "chore(aiw): migrate task handoffs"');
    expect(output).toContain('2. aiw task run refund-123 test');
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
