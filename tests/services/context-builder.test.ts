import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ContextBuilder } from '../../src/services/context-builder.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

describe('ContextBuilder', () => {
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('gives clarification only the current source snapshot', async () => {
    const fixture = await setup();
    const manifest = await fixture.builder.build({ task: fixture.task, nodeId: 'clarify', includes: [] });

    expect(manifest.files).toEqual([{ role: 'source', path: 'sources/requirements/current/snapshot.md' }]);
  });

  it('gives solution only the fact and decision registers', async () => {
    const fixture = await setup();
    const manifest = await fixture.builder.build({ task: fixture.task, nodeId: 'solution', includes: [] });

    expect(manifest.files).toEqual([
      { role: 'artifact', path: 'artifacts/clarify/fact-register.yaml' },
      { role: 'artifact', path: 'artifacts/clarify/decision-register.yaml' },
    ]);
  });

  it('gives plan only the current solution Markdown', async () => {
    const fixture = await setup();
    const manifest = await fixture.builder.build({ task: fixture.task, nodeId: 'plan', includes: [] });

    expect(manifest.files).toEqual([{ role: 'artifact', path: 'artifacts/solution/solution.md' }]);
  });

  it('gives a development node only its isolated unit context', async () => {
    const fixture = await setup();
    fixture.task.nodes['development-list'] = {
      title: '主列表开发', phase: 'development', dependsOn: ['plan'], skill: fixture.task.developmentSkill,
      requiresApproval: false, status: 'ready', hasResult: false,
      outputs: ['artifacts/development/development-list/result.md'],
      contextPath: 'artifacts/plan/units/development-list.yaml', generatedFromPlan: true,
    };
    const manifest = await fixture.builder.build({ task: fixture.task, nodeId: 'development-list', includes: [] });

    expect(manifest.files).toEqual([{ role: 'artifact', path: 'artifacts/plan/units/development-list.yaml' }]);
  });

  it('rejects additional files outside the project root', async () => {
    const fixture = await setup();
    await expect(fixture.builder.build({ task: fixture.task, nodeId: 'clarify', includes: ['../secret.md'] }))
      .rejects.toMatchObject({ code: 'CONTEXT_INVALID' });
  });
});

async function setup() {
  const root = await createTempDirectory('aiw-context-v2-');
  directories.push(root);
  const files: Record<string, string> = {
    'sources/requirements/current/snapshot.md': '# 需求\n',
    'artifacts/clarify/fact-register.yaml': 'schemaVersion: aiw.fact-register/v2\nfacts: []\n',
    'artifacts/clarify/decision-register.yaml': 'schemaVersion: aiw.decision-register/v2\npendingDecisions: []\ncurrentDecisions: []\ndeferredItems: []\n',
    'artifacts/solution/solution.md': '# 技术方案\n',
    'artifacts/plan/units/development-list.yaml': 'title: 主列表开发\n',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  const task = createSevenPhaseTask();
  task.sources.requirements = {
    kind: 'local-file', origin: 'requirements.md', revision: 1,
    snapshotPath: 'sources/requirements/current/snapshot.md', metaPath: 'sources/requirements/current/meta.json',
  };
  return {
    root,
    task,
    builder: new ContextBuilder({ taskDirectory: () => root, projectRoot: () => root }),
  };
}
