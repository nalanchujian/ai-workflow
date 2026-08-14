import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { materializeImplementationWork } from '../../src/services/implementation-work-planner.js';
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

    expect(second.task.nodes['implement-export'].status).toBe('superseded');
    expect(second.task.nodes['implement-export-r2']).toMatchObject({
      contextPath: 'artifacts/work-units/r2/implement-export-r2.md',
      allowedPaths: ['src/services/export-v2.ts'],
    });
    expect(second.task.nodes.verify.dependsOn).toEqual(['implement', 'implement-export-r2']);
  });
});

async function writePlanFacts(store: TaskStore, taskId: string, revision: 'first' | 'second'): Promise<void> {
  const directory = store.taskDirectory(taskId);
  await mkdir(join(directory, 'artifacts'), { recursive: true });
  await writeFile(join(directory, 'artifacts', 'implementation-plan.md'), '# 实施计划\n\n```yaml\nallowedPaths:\n  - src/**\n```\n', 'utf8');
  await writeFile(join(directory, 'artifacts', 'work-breakdown.yaml'), [
    'schemaVersion: aiw.work-breakdown/v1',
    'units:',
    '  - id: page',
    '    title: 实现页面',
    '    goal: 实现列表页面',
    '    allowedPaths:',
    '      - src/pages/links/**',
    '    acceptanceRefs: [AC-01]',
    '    steps: [实现页面]',
    '    verification: [pnpm test -- page]',
    '  - id: export',
    '    title: 实现导出',
    '    goal: 实现导出文件名',
    '    allowedPaths:',
    `      - ${revision === 'first' ? 'src/services/export.ts' : 'src/services/export-v2.ts'}`,
    '    acceptanceRefs: [AC-02]',
    '    steps: [实现导出]',
    '    verification: [pnpm test -- export]',
  ].join('\n') + '\n', 'utf8');
}
