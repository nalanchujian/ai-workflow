import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { completedArtifactPath } from '../../src/domain/handoff.js';
import { materializeImplementationWork } from '../../src/services/implementation-work-planner.js';
import { deliveryNodesImpactedByDecision, deliveryNodesImpactedBySource, materializeImpactGraph, readCurrentImpactGraph } from '../../src/services/task-impact-service.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

describe('TaskImpactService', () => {
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('materializes a versioned source → fact → decision → AC → delivery-unit graph', async () => {
    const { task, store } = await createImpactTask();

    const graph = await readCurrentImpactGraph(task, store);

    expect(graph).toMatchObject({
      schemaVersion: 'aiw.impact-graph/v1',
      taskId: task.id,
      clarifyRevision: 1,
      planRevision: 1,
    });
    expect(graph?.facts).toContainEqual(expect.objectContaining({
      id: 'FACT-API-01',
      sourceIds: ['requirements'],
      decisionIds: ['DEC-API-01'],
      acceptanceRefs: ['AC-01'],
      workUnitIds: ['export'],
      deliveryNodeIds: ['delivery-export'],
    }));
    await expect(deliveryNodesImpactedBySource(task, store, 'requirements')).resolves.toEqual(['delivery-export', 'delivery-page']);
    await expect(deliveryNodesImpactedByDecision(task, store, 'DEC-API-01')).resolves.toEqual(['delivery-export']);
  });

  it('refuses a unit that omits the decision fact required by its acceptance', async () => {
    const { task, store, directory } = await createImpactTask({ invalidUnitFacts: true, materialize: false });

    const materialized = await materializeImplementationWork(task, store);
    await Promise.all(materialized.facts.map((fact) => store.createFact(task.id, fact.path, fact.content)));
    await store.update(materialized.task);
    await expect(materializeImpactGraph(await store.load(task.id), store))
      .rejects.toThrow('缺少其验收或决策依赖的事实');
    expect(directory).toContain('aiw-impact-');
  });
});

async function createImpactTask(options: { invalidUnitFacts?: boolean; materialize?: boolean } = {}): Promise<{ task: ReturnType<typeof createSevenPhaseTask>; store: TaskStore; directory: string }> {
  const directory = await createTempDirectory('aiw-impact-');
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
  task.nodes.clarify = { ...task.nodes.clarify!, status: 'completed', revision: 1 };
  task.nodes.solution = { ...task.nodes.solution!, status: 'completed', revision: 1 };
  task.nodes.plan = { ...task.nodes.plan!, status: 'completed', revision: 1 };
  task.decisions = [{
    id: 'DEC-API-01',
    revision: 1,
    status: 'waiting_external',
    optionId: 'wait-api',
    actor: 'tech-lead',
    at: '2026-08-18T00:00:00.000Z',
    owner: 'backend',
    unblockCondition: '服务端字段契约和联调样例已经确认。',
    factPath: 'decisions/DEC-API-01/r1.yaml',
  }];
  await store.create(task);
  const taskDirectory = store.taskDirectory(task.id);
  const clarifyPath = (name: string) => completedArtifactPath('clarify', task.nodes.clarify!, `artifacts/${name}`);
  const planPath = (name: string) => completedArtifactPath('plan', task.nodes.plan!, `artifacts/${name}`);
  await mkdir(join(taskDirectory, 'sources/requirements/r1'), { recursive: true });
  await mkdir(join(taskDirectory, clarifyPath('fact-register.yaml'), '..'), { recursive: true });
  await mkdir(join(taskDirectory, planPath('implementation-plan.md'), '..'), { recursive: true });
  await writeFile(join(taskDirectory, clarifyPath('fact-register.yaml')), `schemaVersion: aiw.fact-register/v1
items:
  - id: FACT-API-01
    kind: external_dependency
    statement: 服务端尚未提供导出字段、空值语义和文件结构的正式契约。
    confidence: medium
    evidence:
      - sourceId: requirements
        path: sources/requirements/r1/snapshot.md
  - id: FACT-PAGE-01
    kind: confirmed
    statement: 用户可以配置主列表页面的可见字段并保持当前选择。
    confidence: high
    evidence:
      - sourceId: requirements
        path: sources/requirements/r1/snapshot.md
`);
  await writeFile(join(taskDirectory, clarifyPath('acceptance.yaml')), `schemaVersion: aiw.acceptance-catalog/v1
items:
  - id: AC-01
    title: 主列表导出字段一致性
    description: 导出字段与服务端正式契约和当前页面选择保持一致。
    factRefs: [FACT-API-01]
  - id: AC-02
    title: 主列表字段配置
    description: 用户可以配置页面可见字段并在刷新后保持当前选择。
    factRefs: [FACT-PAGE-01]
`);
  await writeFile(join(taskDirectory, clarifyPath('decision-register.yaml')), `schemaVersion: aiw.decision-register/v1
items:
  - id: DEC-API-01
    title: 主列表导出字段契约
    detail:
      question: 本期导出是否基于正式服务端字段契约交付？
      background: 当前仓库未记录服务端字段映射、空值语义和导出排序规则。
      impact: 不确认会使页面字段与导出字段的验收口径不一致。
    type: external-contract
    factRefs: [FACT-API-01]
    affects:
      acceptanceRefs: [AC-01]
      workUnits: [export]
    options:
      - id: use-formal-contract
        title: 使用正式服务端契约
        tradeoffs: 字段口径可端到端验证，但需等待后端提供稳定契约。
    recommendation:
      optionId: use-formal-contract
      rationale: 导出字段必须以服务端契约作为唯一依据，不能由页面推断。
`);
  await writeFile(join(taskDirectory, planPath('implementation-plan.md')), '# 实施计划\n\n## 交付单元\n\n- 分别完成导出与字段配置。\n');
  await writeFile(join(taskDirectory, planPath('work-breakdown.yaml')), `schemaVersion: aiw.work-breakdown/v2
units:
  - id: export
    title: 主列表导出
    goal: 按正式字段契约完成主列表导出。
    acceptanceRefs: [AC-01]
    factRefs: [${options.invalidUnitFacts ? 'FACT-PAGE-01' : 'FACT-API-01'}]
    decisionRefs: [DEC-API-01]
    blockedBy: [DEC-API-01]
    steps: [组装导出字段参数, 校验导出结果]
    verification: [{ profile: vitest, targets: [export] }]
  - id: page
    title: 主列表字段配置
    goal: 支持用户配置并保留主列表可见字段。
    acceptanceRefs: [AC-02]
    factRefs: [FACT-PAGE-01]
    decisionRefs: []
    steps: [实现字段配置, 保存当前选择]
    verification: [{ profile: vitest, targets: [metrics] }]
acceptanceCoverage:
  - acceptanceId: AC-01
    disposition: waiting_external
    decisionId: DEC-API-01
    workUnitIds: [export]
  - acceptanceId: AC-02
    disposition: implement
    workUnitIds: [page]
`);

  if (options.materialize === false) return { task, store, directory };
  const materialized = await materializeImplementationWork(task, store);
  await Promise.all(materialized.facts.map((fact) => store.createFact(task.id, fact.path, fact.content)));
  const graph = await materializeImpactGraph(materialized.task, store);
  await store.createFact(task.id, graph.path, graph.content);
  materialized.task.impactGraph = {
    path: graph.path,
    sha256: graph.sha256,
    clarifyRevision: 1,
    planRevision: 1,
  };
  await store.update(materialized.task);
  return { task: await store.load(task.id), store, directory };
}
