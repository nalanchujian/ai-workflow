import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import { ContextBuilder } from '../../src/services/context-builder.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { TaskFactGuard } from '../../src/services/task-fact-guard.js';
import { TaskRunner } from '../../src/services/task-runner.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask, createSkillLock } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

describe('TaskRunner', () => {
  it('always sends completed requirement analysis to human review', async () => {
    const fixture = await createFixture('requirement-analysis');
    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'requirement-analysis', dryRun: false, includes: [] });
    expect(result.status).toBe('succeeded');
    expect(result.artifacts.map((item) => item.path)).toEqual(['artifacts/requirement-analysis/fact-register.yaml', 'artifacts/requirement-analysis/decision-register.yaml']);
    expect((await fixture.store.load('refund-123')).nodes['requirement-analysis']?.status).toBe('awaiting_approval');
  });

  it('reads and stores the requirement URL snapshot inside requirement analysis', async () => {
    const fixture = await createFixture('requirement-analysis');
    const task = await fixture.store.load('refund-123');
    task.sources = {};
    await fixture.store.update(task);

    await fixture.runner.run({ taskId: task.id, nodeId: 'requirement-analysis', dryRun: false, includes: [] });

    const stored = await fixture.store.load(task.id);
    expect(stored.sources.requirements).toMatchObject({ origin: 'https://acme.larksuite.com/docx/doccn123', snapshotPath: 'sources/requirements/r1/snapshot.md' });
    await expect(readFile(join(fixture.store.taskDirectory(task.id), 'sources/requirements/r1/snapshot.md'), 'utf8')).resolves.toContain('用户可以申请退款');
  });

  it('marks requirement analysis failed when the requirement URL cannot be read', async () => {
    const fixture = await createFixture('source-failure');
    const task = await fixture.store.load('refund-123');
    task.sources = {};
    await fixture.store.update(task);

    await expect(fixture.runner.run({ taskId: task.id, nodeId: 'requirement-analysis', dryRun: false, includes: [] })).rejects.toThrow('无法读取需求文档');
    expect((await fixture.store.load(task.id)).nodes['requirement-analysis']?.status).toBe('failed');
  });

  it('does not allow solution to bypass fixed material nodes', async () => {
    const fixture = await createFixture('requirement-analysis');
    const task = await fixture.store.load('refund-123');
    task.nodes['requirement-analysis']!.status = 'completed';
    task.nodes.solution!.status = 'ready';
    await fixture.store.update(task);

    await expect(fixture.runner.run({ taskId: task.id, nodeId: 'solution', dryRun: false, includes: [] }))
      .rejects.toThrow('请先完成上游节点：design-slicing');
  });

  it('cuts task-local images without writing development-unit bindings', async () => {
    const fixture = await createFixture('design-slicing');
    const task = await prepareDesignTask(fixture.store);

    const result = await fixture.runner.run({ taskId: task.id, nodeId: 'design-slicing', dryRun: false, includes: [] });

    expect(result.status).toBe('succeeded');
    expect((await fixture.store.load(task.id)).nodes['design-slicing']?.status).toBe('completed');
    expect(fixture.prompts).toHaveLength(1);
    expect(fixture.prompts[0]).toContain('输入图片已由用户提前导出');
    expect(fixture.prompts[0]).not.toContain('外部设计地址');
    await expect(readFile(join(fixture.store.taskDirectory(task.id), 'artifacts/plan/units/development-unit-refund-entry.yaml'), 'utf8'))
      .resolves.not.toContain('assetId: refund-flow-block');
  });

  it('rejects design crops outside the original image', async () => {
    const fixture = await createFixture('design-invalid');
    const task = await prepareDesignTask(fixture.store);
    const result = await fixture.runner.run({ taskId: task.id, nodeId: 'design-slicing', dryRun: false, includes: [] });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'ARTIFACT_INVALID' } });
    expect(result.error?.message).toContain('裁切范围');
  });

  it('snapshots every selected API document and validates the source index in the analysis', async () => {
    const fixture = await createFixture('api-analysis');
    const task = await prepareApiTask(fixture.store);

    const result = await fixture.runner.run({ taskId: task.id, nodeId: 'api-analysis', dryRun: false, includes: [] });

    expect(result.status).toBe('succeeded');
    const stored = await fixture.store.load(task.id);
    expect(stored.sources['api/api-document-1']).toMatchObject({ origin: 'https://yapi.hbdev.club/project/149/interface/api/1', snapshotPath: 'sources/api/api-document-1/r1/snapshot.md' });
    expect(stored.sources['api/api-document-2']).toMatchObject({ origin: 'https://yapi.hbdev.club/project/149/interface/api/2', snapshotPath: 'sources/api/api-document-2/r1/snapshot.md' });
    expect(fixture.prompts.at(-1)).toContain('ID：api-document-1');
    expect(fixture.prompts.at(-1)).toContain('<artifact-protocol id="api-analysis"');
    await expect(readFile(join(fixture.store.taskDirectory(task.id), 'artifacts/api-analysis/api-analysis.yaml'), 'utf8')).resolves.toContain('api-document-2');
  });

  it('rejects API analysis whose document index does not match task snapshots', async () => {
    const fixture = await createFixture('api-invalid');
    const task = await prepareApiTask(fixture.store);

    const result = await fixture.runner.run({ taskId: task.id, nodeId: 'api-analysis', dryRun: false, includes: [] });

    expect(result).toMatchObject({ status: 'failed', error: { code: 'ARTIFACT_INVALID' } });
    expect(result.error?.message).toContain('来源索引不匹配');
  });

  it('fails when the agent omits a declared artifact', async () => {
    const fixture = await createFixture('missing-decision');
    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'requirement-analysis', dryRun: false, includes: [] });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'ARTIFACT_MISSING' } });
  });

  it('runs a development unit as code-only work and records a development result', async () => {
    const fixture = await createFixture('development');
    const task = await prepareDevelopmentTask(fixture.store);
    const result = await fixture.runner.run({ taskId: task.id, nodeId: 'development-unit-refund-entry', dryRun: false, includes: [] });
    expect(result.status).toBe('succeeded');
    expect((await fixture.store.load(task.id)).nodes['development-unit-refund-entry']?.status).toBe('completed');
    expect(fixture.prompts.at(-1)).toContain('只完成当前业务单元的代码开发');
  });

  it('fails a development unit that writes a result without changing business code', async () => {
    const fixture = await createFixture('development-no-changes');
    const task = await prepareDevelopmentTask(fixture.store);
    const result = await fixture.runner.run({ taskId: task.id, nodeId: 'development-unit-refund-entry', dryRun: false, includes: [] });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'ARTIFACT_INVALID', message: '开发节点未产生任何业务代码变更' } });
  });

  it('keeps dry-run side-effect free and still produces an inspectable context', async () => {
    const fixture = await createFixture('requirement-analysis');
    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'requirement-analysis', dryRun: true, includes: [] });
    expect(result.status).toBe('succeeded');
    expect(fixture.prompts).toHaveLength(0);
    expect((await fixture.store.load('refund-123')).nodes['requirement-analysis']?.status).toBe('ready');
    await expect(readFile(join(result.runDirectory, 'context.md'), 'utf8')).resolves.toContain('需求分析只读取本次需求文档快照');
  });
});

async function prepareDesignTask(store: TaskStore) {
  const task = await store.load('refund-123');
  task.inputs.design = { status: 'provided', image: { id: 'main', originalName: 'main.png', imagePath: 'sources/design/main.png', mediaType: 'image/png' } };
  task.nodes['requirement-analysis']!.status = 'completed'; task.nodes['api-analysis']!.status = 'completed'; task.nodes['design-slicing']!.status = 'ready';
  task.nodes.solution!.status = 'completed'; task.nodes.plan!.status = 'completed';
  task.nodes['development-unit-refund-entry'] = {
    title: '退款入口', phase: 'development', dependsOn: ['design-slicing'], skills: [createSkillLock('typescript-web-implementation')],
    requiresApproval: false, status: 'pending', hasResult: false, outputs: ['artifacts/development/development-unit-refund-entry/result.md'],
    contextPath: 'artifacts/plan/units/development-unit-refund-entry.yaml', generatedFromPlan: true,
  };
  await store.update(task);
  await store.replaceBinaryFact(task.id, 'sources/design/main.png', Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  await store.replaceFact(task.id, 'artifacts/plan/development-plan.yaml', 'schemaVersion: aiw.development-plan/v2\nunits:\n  - name: development-unit-refund-entry\n    title: 退款入口\n    goal: 增加入口\n    requirements: [可见]\n    codeScope: [src/refund]\n    steps: [实现入口]\n    dependencies: []\n');
  await store.replaceFact(task.id, 'artifacts/plan/units/development-unit-refund-entry.yaml', stringify({ schemaVersion: 'aiw.development-unit/v2', name: 'development-unit-refund-entry', title: '退款入口', goal: '增加入口', requirements: ['可见'], codeScope: ['src/refund'], steps: ['实现入口'], dependencies: [], designReferences: [] }));
  return task;
}

async function prepareApiTask(store: TaskStore) {
  const task = await store.load('refund-123');
  task.nodes['requirement-analysis']!.status = 'completed';
  task.inputs.apiDocuments = { status: 'provided', urls: ['https://yapi.hbdev.club/project/149/interface/api/1', 'https://yapi.hbdev.club/project/149/interface/api/2'] };
  task.nodes['api-analysis'] = {
    title: '接口分析', phase: 'api-analysis', dependsOn: ['requirement-analysis'], skills: [createSkillLock('api-analysis')],
    requiresApproval: false, status: 'ready', hasResult: false, outputs: ['artifacts/api-analysis/api-analysis.yaml'],
  };
  task.nodes.solution!.dependsOn = ['api-analysis'];
  await store.update(task);
  return task;
}

async function prepareDevelopmentTask(store: TaskStore) {
  const task = await store.load('refund-123');
  task.nodes['requirement-analysis']!.status = 'completed'; task.nodes.solution!.status = 'completed'; task.nodes.plan!.status = 'completed';
  task.nodes['development-unit-refund-entry'] = {
    title: '实现退款入口', phase: 'development', dependsOn: ['plan'], skills: [createSkillLock('typescript-web-implementation')],
    requiresApproval: false, status: 'ready', hasResult: false, outputs: ['artifacts/development/development-unit-refund-entry/result.md'],
    contextPath: 'artifacts/plan/units/development-unit-refund-entry.yaml', generatedFromPlan: true,
  };
  await store.update(task);
  await store.replaceFact(task.id, 'artifacts/plan/units/development-unit-refund-entry.yaml', stringify({ schemaVersion: 'aiw.development-unit/v2', name: 'development-unit-refund-entry', title: '退款入口', goal: '增加入口', requirements: ['可见'], codeScope: ['src/refund'], steps: ['实现入口'], dependencies: [], designReferences: [] }));
  return task;
}

async function createFixture(mode: 'design-slicing' | 'design-invalid' | 'api-analysis' | 'api-invalid' | 'requirement-analysis' | 'missing-decision' | 'development' | 'development-no-changes' | 'source-failure') {
  const root = await createTempDirectory('aiw-runner-'); directories.push(root);
  const runtimeRoot = join(root, '.runtime');
  const store = new TaskStore(root);
  const task = createSevenPhaseTask();
  task.repository = root;
  task.sources.requirements = { kind: 'local-file', origin: 'requirements.md', revision: 1, snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json' };
  await store.create(task);
  await store.replaceFact(task.id, 'sources/requirements/r1/snapshot.md', '# 退款需求\n\n用户可以申请退款。\n');
  await store.replaceFact(task.id, 'sources/requirements/r1/meta.json', '{}\n');

  const registry = new SkillRegistry(join(root, 'registry.yaml'));
  const registrySource = { url: 'git@example.test/agent-skills.git', revision: 'a1b2c3d4' };
  await registry.replace({ profiles: [], skills: [
    { name: 'requirement-analysis', version: '1.0.0', description: '需求分析', aiwCompatibility: '>=0.0.1 <1.0.0', artifactContract: 'aiw.task-output/v2', phases: ['requirement-analysis'], body: '分析需求。', registrySource, sha256: 'a'.repeat(64) },
    { name: 'design-slicing', version: '1.0.0', description: '设计图片切割', aiwCompatibility: '>=0.0.1 <1.0.0', artifactContract: 'aiw.task-output/v2', phases: ['design-slicing'], body: '切割设计图片。', registrySource, sha256: 'a'.repeat(64) },
    { name: 'api-analysis', version: '1.0.0', description: '接口分析', aiwCompatibility: '>=0.0.1 <1.0.0', artifactContract: 'aiw.task-output/v2', phases: ['api-analysis'], body: '分析接口。', registrySource, sha256: 'a'.repeat(64) },
    { name: 'typescript-web-implementation', version: '1.0.0', description: '开发', aiwCompatibility: '>=0.0.1 <1.0.0', artifactContract: 'aiw.task-output/v2', phases: ['development'], body: '开发代码。', registrySource, sha256: 'a'.repeat(64) },
  ] });

  const prompts: string[] = [];
  const adapter = new CodexAdapter({ processRunner: { async run(input) {
    prompts.push(input.stdin);
    const taskRoot = join(input.cwd, '.aiw/tasks/refund-123/runs/run-1/staging');
    if (mode === 'design-slicing' || mode === 'design-invalid') {
      const directory = join(taskRoot, 'artifacts/design'); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'design-assets.yaml'), stringify({ schemaVersion: 'aiw.design-assets/v2', source: { image: { id: 'main', originalName: 'main.png', imagePath: 'sources/design/main.png', mediaType: 'image/png' } }, sourceSize: { width: 800, height: 600 }, assets: [{ id: 'refund-flow-block', sourceImageId: 'main', title: '退款流程', imagePath: 'artifacts/design/assets/refund-flow-block.png', crop: { x: 0, y: 0, width: mode === 'design-slicing' ? 800 : 801, height: 600 } }] }));
      const assetDirectory = join(input.cwd, '.aiw/tasks/refund-123/artifacts/design/assets'); await mkdir(assetDirectory, { recursive: true });
      await writeFile(join(assetDirectory, 'refund-flow-block.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'));
    } else if (mode === 'api-analysis' || mode === 'api-invalid') {
      const output = join(taskRoot, 'artifacts/api-analysis/api-analysis.yaml'); await mkdir(dirname(output), { recursive: true });
      const documents = ['orders', 'refunds'].map((name, index) => ({
        id: mode === 'api-invalid' && index === 0 ? 'other-document' : `api-document-${index + 1}`,
        url: `https://yapi.hbdev.club/project/149/interface/api/${index + 1}`,
        snapshotPath: `sources/api/api-document-${index + 1}/r1/snapshot.md`,
        interfaces: [{ id: `list-${name}`, title: `${name} 列表`, method: 'GET', path: `/${name}`, request: '无参数。', response: '列表。', errors: [], constraints: [], missingInformation: [] }],
        missingInformation: [],
      }));
      await writeFile(output, stringify({ schemaVersion: 'aiw.api-analysis/v1', documents }));
    } else if (mode === 'development' || mode === 'development-no-changes') {
      const path = join(taskRoot, 'artifacts/development/development-unit-refund-entry/result.md'); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '# 开发结果\n\n## 完成的代码修改\n\n已实现退款入口。\n\n## 变更文件\n\n- src/refund.ts\n\n## 未解决问题\n\n无。\n\n## 已知风险\n\n无。\n');
    } else {
      const fact = join(taskRoot, 'artifacts/requirement-analysis/fact-register.yaml'); await mkdir(dirname(fact), { recursive: true });
      await writeFile(fact, stringify({ schemaVersion: 'aiw.fact-register/v3', facts: [{ statement: '用户可以申请退款。', source: { type: 'requirement', path: 'sources/requirements/r1/snapshot.md' } }] }));
      if (mode !== 'missing-decision') await writeFile(join(taskRoot, 'artifacts/requirement-analysis/decision-register.yaml'), stringify({ schemaVersion: 'aiw.decision-register/v2', pendingDecisions: [], currentDecisions: [], deferredItems: [] }));
    }
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
  } } });
  const changeInspector = { async changedPaths() { return []; }, async untrackedPaths() { return []; }, async diff() { return ''; }, async revision() { return { head: 'abc', branch: 'main' }; } };
  const taskFactGuard = new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'developer'; } } });
  const runner = new TaskRunner({
    taskStore: store, skillRegistry: registry,
    contextBuilder: new ContextBuilder({ taskDirectory: (value) => store.taskDirectory(value.id), projectRoot: () => root, maxTokens: 20_000 }),
    taskFactGuard, changeInspector, adapter,
    sourceIntake: {
      async snapshot(input: { sourceId: string; value: string }) {
        if (mode === 'source-failure') throw new Error('文档无访问权限');
        return { sourceId: input.sourceId, kind: 'public-url', origin: input.value, revision: 1, fetchedAt: '2026-09-08T00:00:00.000Z', markdown: input.sourceId === 'requirements' ? '# 退款需求\n\n用户可以申请退款。\n' : '# 接口文档\n\n接口内容。\n', extractor: 'plain-text/v1' };
      },
      async writeSnapshot(input: { taskDirectory: string; snapshot: { sourceId: string; markdown: string; kind: 'public-url'; origin: string } }) {
        const directory = join(input.taskDirectory, 'sources', input.snapshot.sourceId, 'r1');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'snapshot.md'), input.snapshot.markdown);
        await writeFile(join(directory, 'meta.json'), '{}\n');
        return { kind: input.snapshot.kind, origin: input.snapshot.origin, revision: 1, snapshotPath: `sources/${input.snapshot.sourceId}/r1/snapshot.md`, metaPath: `sources/${input.snapshot.sourceId}/r1/meta.json` };
      },
    } as never,
    deliveryWorkspaceManager: { async prepare() { return { projectRoot: root, sourceHead: 'abc', async publish() { const changedPaths = mode === 'development' ? ['src/refund.ts'] : []; return { published: changedPaths.length > 0, patch: '', patchSha256: '0'.repeat(64), changedPaths }; }, async rollback() {}, async dispose() {} }; } },
    runtimeRoot, runIdFactory: () => 'run-1',
  });
  return { runner, store, prompts, runtimeRoot };
}
