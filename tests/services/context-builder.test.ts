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

  it('gives browser-based design analysis only the requirement snapshot', async () => {
    const fixture = await setup();
    fixture.task.designInput = { provider: 'figma', url: 'https://www.figma.com/design/file-key/File?node-id=1-2', fileKey: 'file-key', nodeId: '1:2' };
    fixture.task.nodes['design-analysis'] = {
      title: '分析设计稿', phase: 'design', dependsOn: ['intake'], skill: fixture.task.nodes.clarify!.skill,
      requiresApproval: false, status: 'ready', hasResult: false, outputs: ['artifacts/design/design-assets.yaml'],
    };
    const manifest = await fixture.builder.build({ task: fixture.task, nodeId: 'design-analysis', includes: [] });

    expect(manifest.files).toEqual([{ role: 'source', path: 'sources/requirements/current/snapshot.md' }]);
    expect(manifest.images).toEqual([]);
  });

  it('gives solution only the fact and decision registers', async () => {
    const fixture = await setup();
    const manifest = await fixture.builder.build({ task: fixture.task, nodeId: 'solution', includes: [] });

    expect(manifest.files).toEqual([
      { role: 'artifact', path: 'artifacts/clarify/fact-register.yaml' },
      { role: 'artifact', path: 'artifacts/clarify/decision-register.yaml' },
    ]);
  });

  it('propagates the minimal screenshot index through clarification, solution, and planning', async () => {
    const fixture = await setup();
    fixture.task.designInput = { provider: 'figma', url: 'https://www.figma.com/design/file-key/File?node-id=1-2', fileKey: 'file-key', nodeId: '1:2' };

    const clarify = await fixture.builder.build({ task: fixture.task, nodeId: 'clarify', includes: [] });
    const solution = await fixture.builder.build({ task: fixture.task, nodeId: 'solution', includes: [] });
    const plan = await fixture.builder.build({ task: fixture.task, nodeId: 'plan', includes: [] });

    expect(clarify.files.map((file) => file.path)).toEqual([
      'sources/requirements/current/snapshot.md',
      'artifacts/design/design-assets.yaml',
    ]);
    expect(solution.files.map((file) => file.path)).toContain('artifacts/design/design-assets.yaml');
    expect(plan.files.map((file) => file.path)).toContain('artifacts/design/design-assets.yaml');
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

  it('injects only the screenshots assigned to the current development unit', async () => {
    const fixture = await setup();
    fixture.task.nodes['development-list'] = {
      title: '主列表开发', phase: 'development', dependsOn: ['plan'], skill: fixture.task.developmentSkill,
      requiresApproval: false, status: 'ready', hasResult: false,
      outputs: ['artifacts/development/development-list/result.md'], contextPath: 'artifacts/plan/units/development-list.yaml', generatedFromPlan: true,
    };
    await writeFile(join(fixture.root, 'artifacts/plan/units/development-list.yaml'), [
      'schemaVersion: aiw.development-unit/v1', 'name: development-unit-main-list', 'title: 主列表', 'goal: 实现主列表',
      'requirements: [展示列表]', 'codeScope: [src/list]', 'steps: [实现页面]', 'dependencies: []', 'designReferences:',
      '  - assetId: tracking-links-page', '    figmaUrl: https://www.figma.com/design/file-key/File?node-id=1-2',
      '    nodeId: "1:2"', '    imagePath: artifacts/design/assets/tracking-links-page.png', '    purpose: 主列表页面',
    ].join('\n'));
    await mkdir(join(fixture.root, 'artifacts/design/assets'), { recursive: true });
    await writeFile(join(fixture.root, 'artifacts/design/assets/tracking-links-page.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    await writeFile(join(fixture.root, 'artifacts/design/assets/unrelated-dialog.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

    const manifest = await fixture.builder.build({ task: fixture.task, nodeId: 'development-list', includes: [] });

    expect(manifest.images).toEqual([{ path: 'artifacts/design/assets/tracking-links-page.png' }]);
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
    'artifacts/design/design-assets.yaml': 'schemaVersion: aiw.design-assets/v1\nanalysisStatus: completed\n',
    'artifacts/plan/units/development-list.yaml': 'schemaVersion: aiw.development-unit/v1\nname: development-unit-main-list\ntitle: 主列表开发\ngoal: 实现主列表\nrequirements: [展示列表]\ncodeScope: [src/list]\nsteps: [实现页面]\ndependencies: []\ndesignReferences: []\n',
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
