import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { materializeDevelopmentWork, readDevelopmentPlan, validateDevelopmentPlan } from '../../src/services/implementation-work-planner.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

describe('development work planner', () => {
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('reads the current development plan without acceptance or verification mappings', async () => {
    const fixture = await setup();
    const plan = await readDevelopmentPlan(fixture.task, fixture.store);
    expect(plan.units.map((unit) => unit.title)).toEqual(['主列表指标配置', '主列表导出']);
  });

  it('materializes independent development nodes and unit YAML files', async () => {
    const fixture = await setup();
    const materialized = await materializeDevelopmentWork(fixture.task, fixture.store);

    expect(Object.keys(materialized.task.nodes)).toEqual(expect.arrayContaining([
      'development-unit-1', 'development-unit-2',
    ]));
    expect(materialized.task.nodes['development-unit-1']).toMatchObject({
      phase: 'development', dependsOn: ['plan'], requiresApproval: false, status: 'ready', generatedFromPlan: true,
    });
    expect(await readFile(join(fixture.store.taskDirectory(fixture.task.id), 'artifacts/plan/units/development-unit-1.yaml'), 'utf8'))
      .toContain('schemaVersion: aiw.development-unit/v1');
  });

  it('turns declared unit dependencies into executable node dependencies', async () => {
    const fixture = await setup({ secondDependencies: ['主列表指标配置'] });
    const materialized = await materializeDevelopmentWork(fixture.task, fixture.store);

    expect(materialized.task.nodes['development-unit-2']).toMatchObject({
      dependsOn: ['development-unit-1'], status: 'pending',
    });
  });

  it('replaces existing generated nodes instead of creating operation revisions', async () => {
    const fixture = await setup();
    fixture.task.nodes['development-old'] = {
      title: '旧单元', phase: 'development', dependsOn: ['plan'], skill: fixture.task.developmentSkill,
      requiresApproval: false, status: 'completed', hasResult: true, generatedFromPlan: true,
      outputs: ['artifacts/development/development-old/result.md'], contextPath: 'artifacts/plan/units/development-old.yaml',
    };

    const materialized = await materializeDevelopmentWork(fixture.task, fixture.store);

    expect(materialized.task.nodes['development-old']).toBeUndefined();
    expect(Object.keys(materialized.task.nodes).some((id) => id.endsWith('-r2'))).toBe(false);
  });

  it('rejects old work-breakdown fields', () => {
    expect(() => validateDevelopmentPlan('schemaVersion: aiw.work-breakdown/v2\nunits: []\nacceptanceCoverage: []\n'))
      .toThrow(/开发计划格式无效/);
  });

  it('rejects unknown and cyclic development dependencies', () => {
    expect(() => validateDevelopmentPlan([
      'schemaVersion: aiw.development-plan/v1',
      'units:',
      '  - title: A',
      '    goal: A',
      '    requirements: [A]',
      '    codeScope: [src/a]',
      '    steps: [A]',
      '    dependencies: [B]',
    ].join('\n'))).toThrow(/未知开发单元/);
    expect(() => validateDevelopmentPlan([
      'schemaVersion: aiw.development-plan/v1',
      'units:',
      '  - title: A',
      '    goal: A',
      '    requirements: [A]',
      '    codeScope: [src/a]',
      '    steps: [A]',
      '    dependencies: [B]',
      '  - title: B',
      '    goal: B',
      '    requirements: [B]',
      '    codeScope: [src/b]',
      '    steps: [B]',
      '    dependencies: [A]',
    ].join('\n'))).toThrow(/依赖不能形成循环/);
  });
});

async function setup(options: { secondDependencies?: string[] } = {}) {
  const root = await createTempDirectory('aiw-development-plan-');
  directories.push(root);
  const store = new TaskStore(root);
  const task = createSevenPhaseTask();
  task.nodes.intake!.status = 'completed';
  task.nodes.clarify!.status = 'completed';
  task.nodes.solution!.status = 'completed';
  task.nodes.plan!.status = 'completed';
  task.nodes.plan!.hasResult = true;
  await mkdir(join(store.taskDirectory(task.id), 'artifacts/plan'), { recursive: true });
  await writeFile(join(store.taskDirectory(task.id), 'artifacts/plan/development-plan.yaml'), [
    'schemaVersion: aiw.development-plan/v1',
    'units:',
    '  - title: 主列表指标配置',
    '    goal: 支持调整并保存主列表指标。',
    '    requirements: [支持调整指标顺序]',
    '    codeScope: [src/pages/growth/links/components/custom-metrics/]',
    '    steps: [调整指标配置模型]',
    '    dependencies: []',
    '  - title: 主列表导出',
    '    goal: 根据当前选择组装主列表导出参数。',
    '    requirements: [支持当前可见字段]',
    '    codeScope: [src/pages/growth/links/components/export/]',
    '    steps: [更新导出参数组装]',
    `    dependencies: [${(options.secondDependencies ?? []).join(', ')}]`,
    '',
  ].join('\n'), 'utf8');
  return { root, store, task };
}
