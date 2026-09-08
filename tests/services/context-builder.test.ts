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
    const manifest = await fixture.builder.build({ task: fixture.task, nodeId: 'requirement-analysis', includes: [] });

    expect(manifest.files).toEqual([{ role: 'source', path: 'sources/requirements/current/snapshot.md' }]);
  });

  it('gives design slicing only the single task-local image', async () => {
    const fixture = await setup();
    fixture.task.inputs.design = { status: 'provided', image: { id: 'main', originalName: 'main.png', imagePath: 'sources/design/main.png', mediaType: 'image/png' } };
    fixture.task.nodes['design-slicing'] = {
      title: '切割并绑定设计图片', phase: 'design-slicing', dependsOn: ['plan'], skills: fixture.task.nodes['requirement-analysis']!.skills,
      requiresApproval: false, status: 'ready', hasResult: false, outputs: ['artifacts/design/design-assets.yaml'],
    };
    const manifest = await fixture.builder.build({ task: fixture.task, nodeId: 'design-slicing', includes: [] });

    expect(manifest.files).toEqual([]);
    expect(manifest.images).toEqual([{ path: 'sources/design/main.png' }]);
  });

  it('gives solution only the fact and decision registers', async () => {
    const fixture = await setup();
    const manifest = await fixture.builder.build({ task: fixture.task, nodeId: 'solution', includes: [] });

    expect(manifest.files).toEqual([
      { role: 'artifact', path: 'artifacts/requirement-analysis/fact-register.yaml' },
      { role: 'artifact', path: 'artifacts/requirement-analysis/decision-register.yaml' },
    ]);
  });

  it('gives solution API analysis but never design assets, then gives plan both optional catalogs', async () => {
    const fixture = await setup();
    fixture.task.inputs.apiDocuments = { status: 'provided', urls: ['https://yapi.hbdev.club/project/149/interface/api/1'] };
    fixture.task.inputs.design = { status: 'provided', image: { id: 'main', originalName: 'main.png', imagePath: 'sources/design/main.png', mediaType: 'image/png' } };
    fixture.task.nodes['api-analysis'] = { title: '接口分析', phase: 'api-analysis', dependsOn: ['requirement-analysis'], skills: fixture.task.developmentSkills, requiresApproval: false, status: 'completed', hasResult: true, outputs: ['artifacts/api-analysis/api-analysis.yaml'] };
    fixture.task.nodes['design-slicing'] = { title: '设计图切割', phase: 'design-slicing', dependsOn: ['api-analysis'], skills: fixture.task.developmentSkills, requiresApproval: false, status: 'completed', hasResult: true, outputs: ['artifacts/design/design-assets.yaml'] };

    const requirementAnalysis = await fixture.builder.build({ task: fixture.task, nodeId: 'requirement-analysis', includes: [] });
    const solution = await fixture.builder.build({ task: fixture.task, nodeId: 'solution', includes: [] });
    const plan = await fixture.builder.build({ task: fixture.task, nodeId: 'plan', includes: [] });

    expect(requirementAnalysis.files.map((file) => file.path)).toEqual(['sources/requirements/current/snapshot.md']);
    expect(solution.files.map((file) => file.path)).toEqual([
      'artifacts/requirement-analysis/fact-register.yaml', 'artifacts/requirement-analysis/decision-register.yaml', 'artifacts/api-analysis/api-analysis.yaml',
    ]);
    expect(plan.files.map((file) => file.path)).toEqual([
      'artifacts/solution/solution.md', 'artifacts/api-analysis/api-analysis.yaml', 'artifacts/design/design-assets.yaml',
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
      title: '主列表开发', phase: 'development', dependsOn: ['plan'], skills: fixture.task.developmentSkills,
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
      title: '主列表开发', phase: 'development', dependsOn: ['plan'], skills: fixture.task.developmentSkills,
      requiresApproval: false, status: 'ready', hasResult: false,
      outputs: ['artifacts/development/development-list/result.md'], contextPath: 'artifacts/plan/units/development-list.yaml', generatedFromPlan: true,
    };
    await writeFile(join(fixture.root, 'artifacts/plan/units/development-list.yaml'), [
      'schemaVersion: aiw.development-unit/v2', 'name: development-unit-main-list', 'title: 主列表', 'goal: 实现主列表',
      'requirements: [展示列表]', 'codeScope: [src/list]', 'steps: [实现页面]', 'dependencies: []', 'designReferences:',
      '  - assetId: tracking-links-page', '    imagePath: artifacts/design/assets/tracking-links-page.png', '    purpose: 主列表页面',
    ].join('\n'));
    await mkdir(join(fixture.root, 'artifacts/design/assets'), { recursive: true });
    await writeFile(join(fixture.root, 'artifacts/design/assets/tracking-links-page.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    await writeFile(join(fixture.root, 'artifacts/design/assets/unrelated-dialog.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

    const manifest = await fixture.builder.build({ task: fixture.task, nodeId: 'development-list', includes: [] });

    expect(manifest.images).toEqual([{ path: 'artifacts/design/assets/tracking-links-page.png' }]);
  });

  it('rejects additional files outside the project root', async () => {
    const fixture = await setup();
    await expect(fixture.builder.build({ task: fixture.task, nodeId: 'requirement-analysis', includes: ['../secret.md'] }))
      .rejects.toMatchObject({ code: 'CONTEXT_INVALID' });
  });
});

async function setup() {
  const root = await createTempDirectory('aiw-context-v2-');
  directories.push(root);
  const files: Record<string, string> = {
    'sources/requirements/current/snapshot.md': '# 需求\n',
    'artifacts/requirement-analysis/fact-register.yaml': 'schemaVersion: aiw.fact-register/v3\nfacts: []\n',
    'artifacts/requirement-analysis/decision-register.yaml': 'schemaVersion: aiw.decision-register/v2\npendingDecisions: []\ncurrentDecisions: []\ndeferredItems: []\n',
    'artifacts/solution/solution.md': '# 技术方案\n',
    'artifacts/api-analysis/api-analysis.yaml': 'schemaVersion: aiw.api-analysis/v1\ndocuments: []\n',
    'artifacts/plan/development-plan.yaml': 'schemaVersion: aiw.development-plan/v2\nunits:\n  - name: development-unit-main-list\n    title: 主列表\n    goal: 实现主列表\n    requirements: [展示列表]\n    codeScope: [src/list]\n    steps: [实现页面]\n    dependencies: []\n',
    'artifacts/design/design-assets.yaml': 'schemaVersion: aiw.design-assets/v2\nanalysisStatus: completed\n',
    'sources/design/main.png': '',
    'artifacts/plan/units/development-list.yaml': 'schemaVersion: aiw.development-unit/v2\nname: development-unit-main-list\ntitle: 主列表开发\ngoal: 实现主列表\nrequirements: [展示列表]\ncodeScope: [src/list]\nsteps: [实现页面]\ndependencies: []\ndesignReferences: []\n',
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
