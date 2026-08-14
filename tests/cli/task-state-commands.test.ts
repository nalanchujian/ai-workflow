import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

import { createTaskStateCommand, TaskStateCommands } from '../../src/cli/task-state-commands.js';
import { TaskFactGuard } from '../../src/services/task-fact-guard.js';
import { TaskStore } from '../../src/services/task-store.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';
import { handoffPath, outputPathsForCompletedRun } from '../../src/domain/handoff.js';

const directories: string[] = [];

describe('TaskStateCommands', () => {
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

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

  it('records changes requested with a next revision instruction', async () => {
    const { store, directory } = await createApprovalTask('plan');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; } } }),
    });

    await commands.requestChanges('refund-123', 'plan', { actor: 'tech-lead', note: '补充回滚方案' });

    await expect(readFile(join(directory, 'revisions', 'plan', 'r2.md'), 'utf8')).resolves.toContain('补充回滚方案');
    expect((await store.load('refund-123')).nodes.plan.status).toBe('ready');
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

  it('tells users to commit a requested change before rerunning the ready node', async () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'completed';
    task.nodes.plan.status = 'ready';
    let output = '';
    const command = createTaskStateCommand({
      commands: { async requestChanges() { return task; } } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'task', 'request-changes', 'refund-123', 'plan', '--note', '补充范围']);

    expect(output).toContain('1. git add .aiw && git commit -m "chore(aiw): record plan changes"');
    expect(output).toContain('2. aiw task run refund-123 plan');
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
