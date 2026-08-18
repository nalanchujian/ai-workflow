import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { materializeImplementationWork, validateWorkBreakdown } from '../../src/services/implementation-work-planner.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

describe('ImplementationWorkPlanner', () => {
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('replaces obsolete generated subtasks when an updated plan creates a new work graph', async () => {
    const projectRoot = await createTempDirectory('aiw-work-planner-');
    directories.push(projectRoot);
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();
    task.nodes.plan.status = 'completed';
    task.nodes.plan.revision = 1;
    await store.create(task);
    await writePlanFacts(store, task.id, 'first');

    const first = await materializeImplementationWork(await store.load(task.id), store);
    await Promise.all(first.facts.map((fact) => store.createFact(task.id, fact.path, fact.content)));
    await store.update(first.task);

    const revised = await store.load(task.id);
    revised.nodes.plan.status = 'completed';
    revised.nodes.plan.revision = 2;
    revised.nodes.verify.status = 'invalidated';
    await store.update(revised);
    await writePlanFacts(store, task.id, 'second');

    const second = await materializeImplementationWork(await store.load(task.id), store);

    expect(second.task.nodes['implement-page'].status).toBe('superseded');
    expect(second.task.nodes['implement-export'].status).toBe('superseded');
    expect(second.task.nodes['implement-export-r2']).toMatchObject({
      contextPath: 'artifacts/work-units/r2/implement-export-r2.md',
    });
    expect(second.task.nodes.verify.dependsOn).toEqual(['implement-page-r2', 'implement-export-r2']);
  });

  it('keeps a work unit visible but blocked when its decision is waiting for an external condition', async () => {
    const projectRoot = await createTempDirectory('aiw-work-planner-');
    directories.push(projectRoot);
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();
    task.nodes.plan.status = 'completed';
    task.nodes.plan.revision = 1;
    task.decisions = [{
      id: 'DEC-API-01', revision: 1, status: 'waiting_external', optionId: 'wait-api', actor: 'tech-lead',
      at: '2026-08-14T00:00:00.000Z', owner: 'backend', unblockCondition: '接口契约与联调样例已确认', factPath: 'decisions/DEC-API-01/r1.yaml',
    }];
    await store.create(task);
    await writePlanFacts(store, task.id, 'first', true);

    const materialized = await materializeImplementationWork(await store.load(task.id), store);

    expect(materialized.task.nodes['implement-export']).toMatchObject({ status: 'blocked', blockedByDecisionIds: ['DEC-API-01'] });
    expect(materialized.task.status).toBe('partially_blocked');
  });

  it('removes a deferred work unit from the verify merge so unrelated work can continue', async () => {
    const projectRoot = await createTempDirectory('aiw-work-planner-');
    directories.push(projectRoot);
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();
    task.nodes.plan.status = 'completed';
    task.nodes.plan.revision = 1;
    task.decisions = [{
      id: 'DEC-API-01', revision: 1, status: 'deferred', optionId: 'wait-api', actor: 'tech-lead',
      at: '2026-08-14T00:00:00.000Z', note: '接口另行排期', factPath: 'decisions/DEC-API-01/r1.yaml',
    }];
    await store.create(task);
    await writePlanFacts(store, task.id, 'first', true);

    const materialized = await materializeImplementationWork(await store.load(task.id), store);

    expect(materialized.task.nodes['implement-export'].status).toBe('superseded');
    expect(materialized.task.nodes.verify.dependsOn).toEqual(['implement-page']);
  });

  it('keeps verify dependent on implement when the plan has exactly one work unit', async () => {
    const projectRoot = await createTempDirectory('aiw-work-planner-');
    directories.push(projectRoot);
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();
    task.nodes.plan.status = 'completed';
    task.nodes.plan.revision = 1;
    await store.create(task);
    await writePlanFacts(store, task.id, 'first');
    await writeFile(join(store.taskDirectory(task.id), 'artifacts', 'work-breakdown.yaml'), [
      'schemaVersion: aiw.work-breakdown/v1',
      'units:',
      '  - id: main',
      '    title: 完成退款功能',
      '    goal: 完成退款功能的最小实现',
      '    acceptanceRefs: [AC-01]',
      '    steps: [实现退款流程]',
      '    verification: [pnpm test]',
      'acceptanceCoverage:',
      '  - acceptanceId: AC-01',
      '    disposition: implement',
      '    workUnitIds: [main]',
    ].join('\n') + '\n', 'utf8');
    await writeFile(join(store.taskDirectory(task.id), 'artifacts', 'acceptance.yaml'), [
      'schemaVersion: aiw.acceptance-catalog/v1',
      'items:',
      '  - id: AC-01',
      '    title: 退款申请',
      '    description: 用户可以提交退款申请并查看处理结果。',
    ].join('\n') + '\n', 'utf8');

    const materialized = await materializeImplementationWork(await store.load(task.id), store);

    expect(materialized.task.nodes.implement.status).toBe('ready');
    expect(materialized.task.nodes.verify.dependsOn).toEqual(['implement']);
  });

  it('explains incorrect acceptance coverage fields by item and replacement field name', () => {
    const invalidBreakdown = [
      'schemaVersion: aiw.work-breakdown/v1',
      'units:',
      '  - id: page',
      '    title: 实现页面',
      '    goal: 实现列表页面',
      '    acceptanceRefs: [AC-01]',
      '    steps: [实现页面]',
      '    verification: [pnpm test -- page]',
      'acceptanceCoverage:',
      '  - acceptanceRef: AC-01',
      '    status: implement',
      '    units: [page]',
    ].join('\n');
    expect(() => validateWorkBreakdown(invalidBreakdown)).toThrow('验收覆盖第 1 项');
    expect(() => validateWorkBreakdown(invalidBreakdown)).toThrow('不能使用 acceptanceRef；请改为 acceptanceId。');
    expect(() => validateWorkBreakdown(invalidBreakdown)).toThrow('不能使用 status；请改为 disposition。');
    expect(() => validateWorkBreakdown(invalidBreakdown)).toThrow('不能使用 units；请改为 workUnitIds。');
  });
});

async function writePlanFacts(store: TaskStore, taskId: string, revision: 'first' | 'second', blockExport = false): Promise<void> {
  const directory = store.taskDirectory(taskId);
  const task = await store.load(taskId);
  const exportCoverage = task.decisions.find((decision) => decision.id === 'DEC-API-01')?.status;
  await mkdir(join(directory, 'artifacts'), { recursive: true });
  await writeFile(join(directory, 'artifacts', 'implementation-plan.md'), '# 实施计划\n\n## 实施单元\n\n- 完成列表和导出功能。\n\n## 范围与边界\n\n- 保持现有接口边界。\n\n## 验证方式\n\n- pnpm test\n', 'utf8');
  await writeFile(join(directory, 'artifacts', 'acceptance.yaml'), [
    'schemaVersion: aiw.acceptance-catalog/v1',
    'items:',
    '  - id: AC-01',
    '    title: 列表页面',
    '    description: 用户可以完成列表页面的筛选与查看。',
    '  - id: AC-02',
    '    title: 导出文件',
    '    description: 用户可以获得符合规则的导出文件名称。',
  ].join('\n') + '\n', 'utf8');
  await writeFile(join(directory, 'artifacts', 'work-breakdown.yaml'), [
    'schemaVersion: aiw.work-breakdown/v1',
    'units:',
    '  - id: page',
    '    title: 实现页面',
    '    goal: 实现列表页面',
    '    acceptanceRefs: [AC-01]',
    '    steps: [实现页面]',
    '    verification: [pnpm test -- page]',
    '  - id: export',
    '    title: 实现导出',
    '    goal: 实现导出文件名',
    '    acceptanceRefs: [AC-02]',
    '    steps: [实现导出]',
    '    verification: [pnpm test -- export]',
    ...(blockExport ? ['    blockedBy: [DEC-API-01]'] : []),
    'acceptanceCoverage:',
    '  - acceptanceId: AC-01',
    '    disposition: implement',
    '    workUnitIds: [page]',
    ...(blockExport && exportCoverage === 'waiting_external'
      ? ['  - acceptanceId: AC-02', '    disposition: waiting_external', '    decisionId: DEC-API-01', '    workUnitIds: [export]']
      : blockExport && exportCoverage === 'deferred'
        ? ['  - acceptanceId: AC-02', '    disposition: deferred', '    decisionId: DEC-API-01', '    workUnitIds: []']
        : ['  - acceptanceId: AC-02', '    disposition: implement', '    workUnitIds: [export]']),
  ].join('\n') + '\n', 'utf8');
}
