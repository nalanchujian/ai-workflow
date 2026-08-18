import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { materializeImplementationWork, validateWorkBreakdown } from '../../src/services/implementation-work-planner.js';
import { TaskStore } from '../../src/services/task-store.js';
import { completedArtifactPath } from '../../src/domain/handoff.js';
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
    await store.update(revised);
    await writePlanFacts(store, task.id, 'second');

    const second = await materializeImplementationWork(await store.load(task.id), store);

    expect(second.task.nodes['delivery-page'].status).toBe('superseded');
    expect(second.task.nodes['delivery-export'].status).toBe('superseded');
    expect(second.task.nodes['delivery-export-r2']).toMatchObject({
      contextPath: 'artifacts/work-units/r2/delivery-export-r2.md',
    });
    expect(second.task.nodes['delivery-export-r2']?.dependsOn).toEqual(['plan']);
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

    expect(materialized.task.nodes['delivery-export']).toMatchObject({ status: 'blocked', blockedByDecisionIds: ['DEC-API-01'] });
    expect(materialized.task.status).toBe('partially_blocked');
  });

  it('supersedes a deferred delivery unit while unrelated delivery can continue', async () => {
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

    expect(materialized.task.nodes['delivery-export']?.status).toBe('superseded');
    expect(materialized.task.nodes['delivery-page']?.status).toBe('ready');
  });

  it('materializes a named delivery unit even when the plan has exactly one unit', async () => {
    const projectRoot = await createTempDirectory('aiw-work-planner-');
    directories.push(projectRoot);
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();
    task.nodes.plan.status = 'completed';
    task.nodes.plan.revision = 1;
    await store.create(task);
    await writePlanFacts(store, task.id, 'first');
    const current = await store.load(task.id);
    const planBreakdownPath = completedArtifactPath('plan', current.nodes.plan!, 'artifacts/work-breakdown.yaml');
    const acceptancePath = completedArtifactPath('clarify', current.nodes.clarify!, 'artifacts/acceptance.yaml');
    const factPath = completedArtifactPath('clarify', current.nodes.clarify!, 'artifacts/fact-register.yaml');
    const decisionPath = completedArtifactPath('clarify', current.nodes.clarify!, 'artifacts/decision-register.yaml');
    await mkdir(join(store.taskDirectory(task.id), planBreakdownPath, '..'), { recursive: true });
    await mkdir(join(store.taskDirectory(task.id), acceptancePath, '..'), { recursive: true });
    await mkdir(join(store.taskDirectory(task.id), factPath, '..'), { recursive: true });
    await writeFile(join(store.taskDirectory(task.id), planBreakdownPath), [
      'schemaVersion: aiw.work-breakdown/v1',
      'units:',
      '  - id: main',
      '    title: 完成退款功能',
      '    goal: 完成退款功能的最小实现',
      '    acceptanceRefs: [AC-01]',
      '    factRefs: [FACT-REFUND-01]',
      '    decisionRefs: []',
      '    steps: [实现退款流程]',
      '    verification: [pnpm test]',
      'acceptanceCoverage:',
      '  - acceptanceId: AC-01',
      '    disposition: implement',
      '    workUnitIds: [main]',
    ].join('\n') + '\n', 'utf8');
    await writeFile(join(store.taskDirectory(task.id), acceptancePath), [
      'schemaVersion: aiw.acceptance-catalog/v1',
      'items:',
      '  - id: AC-01',
      '    title: 退款申请',
      '    description: 用户可以提交退款申请并查看处理结果。',
      '    factRefs: [FACT-REFUND-01]',
    ].join('\n') + '\n', 'utf8');
    await writeFile(join(store.taskDirectory(task.id), factPath), [
      'schemaVersion: aiw.fact-register/v1',
      'items:',
      '  - id: FACT-REFUND-01',
      '    kind: confirmed',
      '    statement: 用户能够提交退款申请并查看退款处理结果。',
      '    confidence: high',
      '    evidence:',
      '      - sourceId: requirements',
      '        path: sources/requirements/r1/snapshot.md',
    ].join('\n') + '\n', 'utf8');
    await writeFile(join(store.taskDirectory(task.id), decisionPath), 'schemaVersion: aiw.decision-register/v1\nitems: []\n', 'utf8');

    const materialized = await materializeImplementationWork(await store.load(task.id), store);

    expect(materialized.task.nodes.implement.status).toBe('superseded');
    expect(materialized.task.nodes['delivery-main']).toMatchObject({
      status: 'ready',
      acceptanceRefs: ['AC-01'],
      outputs: ['artifacts/delivery.md', 'artifacts/test-results.yaml', 'artifacts/acceptance-results.yaml'],
    });
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
  if (task.nodes.clarify!.revision === 0) {
    task.nodes.clarify = { ...task.nodes.clarify!, status: 'completed', revision: 1 };
    await store.update(task);
  }
  const exportCoverage = task.decisions.find((decision) => decision.id === 'DEC-API-01')?.status;
  await mkdir(join(directory, 'artifacts'), { recursive: true });
  const planPath = completedArtifactPath('plan', task.nodes.plan!, 'artifacts/implementation-plan.md');
  const acceptancePath = completedArtifactPath('clarify', task.nodes.clarify!, 'artifacts/acceptance.yaml');
  const factPath = completedArtifactPath('clarify', task.nodes.clarify!, 'artifacts/fact-register.yaml');
  const decisionPath = completedArtifactPath('clarify', task.nodes.clarify!, 'artifacts/decision-register.yaml');
  const breakdownPath = completedArtifactPath('plan', task.nodes.plan!, 'artifacts/work-breakdown.yaml');
  await mkdir(join(directory, planPath, '..'), { recursive: true });
  await mkdir(join(directory, acceptancePath, '..'), { recursive: true });
  await mkdir(join(directory, factPath, '..'), { recursive: true });
  await writeFile(join(directory, planPath), '# 实施计划\n\n## 实施单元\n\n- 完成列表和导出功能。\n\n## 范围与边界\n\n- 保持现有接口边界。\n\n## 验证方式\n\n- pnpm test\n', 'utf8');
  await writeFile(join(directory, acceptancePath), [
    'schemaVersion: aiw.acceptance-catalog/v1',
    'items:',
    '  - id: AC-01',
    '    title: 列表页面',
    '    description: 用户可以完成列表页面的筛选与查看。',
    '    factRefs: [FACT-PAGE-01]',
    '  - id: AC-02',
    '    title: 导出文件',
    '    description: 用户可以获得符合规则的导出文件名称。',
    '    factRefs: [FACT-EXPORT-01]',
  ].join('\n') + '\n', 'utf8');
  await writeFile(join(directory, factPath), [
    'schemaVersion: aiw.fact-register/v1',
    'items:',
    '  - id: FACT-PAGE-01',
    '    kind: confirmed',
    '    statement: 用户需要在列表页面完成筛选和查看操作。',
    '    confidence: high',
    '    evidence:',
    '      - sourceId: requirements',
    '        path: sources/requirements/r1/snapshot.md',
    '  - id: FACT-EXPORT-01',
    '    kind: confirmed',
    '    statement: 用户需要获取符合既定规则的导出文件名称。',
    '    confidence: high',
    '    evidence:',
    '      - sourceId: requirements',
    '        path: sources/requirements/r1/snapshot.md',
  ].join('\n') + '\n', 'utf8');
  const decisionRegister = blockExport ? [
    'schemaVersion: aiw.decision-register/v1',
    'items:',
    '  - id: DEC-API-01',
    '    title: 导出服务端契约',
    '    detail:',
    '      question: 当前导出接口是否支持本期所需的字段与排序？',
    '      background: 仓库尚未记录服务端字段映射、空值语义和导出顺序。',
    '      impact: 不确认会使导出结果无法按照验收标准稳定验证。',
    '    type: external-contract',
    '    factRefs: [FACT-EXPORT-01]',
    '    affects:',
    '      acceptanceRefs: [AC-02]',
    '      workUnits: [export]',
    '    status: proposed',
    '    options:',
    '      - id: use-contract',
    '        title: 使用正式服务端契约',
    '        tradeoffs: 字段口径一致，但需要后端提供可用契约。',
    '        effect: resolved',
    '    recommendation:',
    '      optionId: use-contract',
    '      rationale: 当前导出行为必须以服务端字段契约作为唯一依据。',
  ] : [
    'schemaVersion: aiw.decision-register/v1',
    'items: []',
  ];
  await writeFile(join(directory, decisionPath), decisionRegister.join('\n') + '\n', 'utf8');
  await writeFile(join(directory, breakdownPath), [
    'schemaVersion: aiw.work-breakdown/v1',
    'units:',
    '  - id: page',
    '    title: 实现页面',
    '    goal: 实现列表页面',
    '    acceptanceRefs: [AC-01]',
    '    factRefs: [FACT-PAGE-01]',
    '    decisionRefs: []',
    '    steps: [实现页面]',
    '    verification: [pnpm test -- page]',
    '  - id: export',
    '    title: 实现导出',
    '    goal: 实现导出文件名',
    '    acceptanceRefs: [AC-02]',
    '    factRefs: [FACT-EXPORT-01]',
    ...(blockExport ? ['    decisionRefs: [DEC-API-01]'] : ['    decisionRefs: []']),
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
