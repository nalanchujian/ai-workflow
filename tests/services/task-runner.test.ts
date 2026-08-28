import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import { ContextBuilder } from '../../src/services/context-builder.js';
import { MethodSourceResolver } from '../../src/services/method-source-resolver.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { TaskFactGuard } from '../../src/services/task-fact-guard.js';
import { TaskRunner } from '../../src/services/task-runner.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask, createSkillLock } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

describe('TaskRunner', () => {
  it('runs clarification with only the two declared YAML artifacts', async () => {
    const fixture = await createFixture('clarify');
    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });
    expect(result.status).toBe('succeeded');
    expect(result.artifacts.map((item) => item.path)).toEqual(['artifacts/clarify/fact-register.yaml', 'artifacts/clarify/decision-register.yaml']);
    expect((await fixture.store.load('refund-123')).nodes.clarify?.status).toBe('awaiting_approval');
  });

  it('uses task-local images to cut and bind design assets after planning', async () => {
    const fixture = await createFixture('design');
    const task = await prepareDesignTask(fixture.store);

    const result = await fixture.runner.run({ taskId: task.id, nodeId: 'design-analysis', dryRun: false, includes: [] });

    expect(result.status).toBe('succeeded');
    expect((await fixture.store.load(task.id)).nodes['design-analysis']?.status).toBe('completed');
    expect(fixture.prompts).toHaveLength(1);
    expect(fixture.prompts[0]).toContain('输入图片已由用户提前导出');
    expect(fixture.prompts[0]).not.toContain('外部设计地址');
    await expect(readFile(join(fixture.store.taskDirectory(task.id), 'artifacts/plan/units/development-unit-refund-entry.yaml'), 'utf8'))
      .resolves.toContain('assetId: refund-flow-block');
  });

  it('rejects design output bound to an unknown development unit', async () => {
    const fixture = await createFixture('design-invalid');
    const task = await prepareDesignTask(fixture.store);
    const result = await fixture.runner.run({ taskId: task.id, nodeId: 'design-analysis', dryRun: false, includes: [] });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'ARTIFACT_INVALID' } });
    expect(result.error?.message).toContain('未知开发单元');
  });

  it('fails when the agent omits a declared artifact', async () => {
    const fixture = await createFixture('missing-decision');
    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });
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
    const fixture = await createFixture('clarify');
    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: true, includes: [] });
    expect(result.status).toBe('succeeded');
    expect(fixture.prompts).toHaveLength(0);
    expect((await fixture.store.load('refund-123')).nodes.clarify?.status).toBe('ready');
    await expect(readFile(join(result.runDirectory, 'context.md'), 'utf8')).resolves.toContain('只生成事实登记和决策登记');
  });
});

async function prepareDesignTask(store: TaskStore) {
  const task = await store.load('refund-123');
  task.designInput = { provider: 'local-images', images: [{ id: 'main', originalName: 'main.png', imagePath: 'sources/design/main.png', mediaType: 'image/png' }] };
  task.nodes.clarify!.status = 'completed'; task.nodes.solution!.status = 'completed'; task.nodes.plan!.status = 'completed';
  task.nodes['design-analysis'] = {
    title: '切割并绑定设计图片', phase: 'design', dependsOn: ['plan'], skill: createSkillLock('design-image-segmentation'),
    requiresApproval: false, status: 'ready', hasResult: false, outputs: ['artifacts/design/design-assets.yaml'],
  };
  task.nodes['development-unit-refund-entry'] = {
    title: '退款入口', phase: 'development', dependsOn: ['design-analysis'], skill: createSkillLock('typescript-web-implementation'),
    requiresApproval: false, status: 'pending', hasResult: false, outputs: ['artifacts/development/development-unit-refund-entry/result.md'],
    contextPath: 'artifacts/plan/units/development-unit-refund-entry.yaml', generatedFromPlan: true,
  };
  await store.update(task);
  await store.replaceBinaryFact(task.id, 'sources/design/main.png', Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  await store.replaceFact(task.id, 'artifacts/plan/development-plan.yaml', 'schemaVersion: aiw.development-plan/v1\nunits:\n  - name: development-unit-refund-entry\n    title: 退款入口\n    goal: 增加入口\n    requirements: [可见]\n    codeScope: [src/refund]\n    steps: [实现入口]\n    dependencies: []\n');
  await store.replaceFact(task.id, 'artifacts/plan/units/development-unit-refund-entry.yaml', stringify({ schemaVersion: 'aiw.development-unit/v1', name: 'development-unit-refund-entry', title: '退款入口', goal: '增加入口', requirements: ['可见'], codeScope: ['src/refund'], steps: ['实现入口'], dependencies: [], designReferences: [] }));
  return task;
}

async function prepareDevelopmentTask(store: TaskStore) {
  const task = await store.load('refund-123');
  task.nodes.clarify!.status = 'completed'; task.nodes.solution!.status = 'completed'; task.nodes.plan!.status = 'completed';
  task.nodes['development-unit-refund-entry'] = {
    title: '实现退款入口', phase: 'development', dependsOn: ['plan'], skill: createSkillLock('typescript-web-implementation'),
    requiresApproval: false, status: 'ready', hasResult: false, outputs: ['artifacts/development/development-unit-refund-entry/result.md'],
    contextPath: 'artifacts/plan/units/development-unit-refund-entry.yaml', generatedFromPlan: true,
  };
  await store.update(task);
  await store.replaceFact(task.id, 'artifacts/plan/units/development-unit-refund-entry.yaml', stringify({ schemaVersion: 'aiw.development-unit/v1', name: 'development-unit-refund-entry', title: '退款入口', goal: '增加入口', requirements: ['可见'], codeScope: ['src/refund'], steps: ['实现入口'], dependencies: [], designReferences: [] }));
  return task;
}

async function createFixture(mode: 'design' | 'design-invalid' | 'clarify' | 'missing-decision' | 'development' | 'development-no-changes') {
  const root = await createTempDirectory('aiw-runner-'); directories.push(root);
  const runtimeRoot = join(root, '.runtime');
  const store = new TaskStore(root);
  const task = createSevenPhaseTask();
  task.repository = root;
  task.sources.requirements = { kind: 'local-file', origin: 'requirements.md', revision: 1, snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json' };
  task.nodes.intake!.outputs = ['sources/requirements/r1/snapshot.md', 'sources/requirements/r1/meta.json'];
  await store.create(task);
  await store.replaceFact(task.id, 'sources/requirements/r1/snapshot.md', '# 退款需求\n\n用户可以申请退款。\n');
  await store.replaceFact(task.id, 'sources/requirements/r1/meta.json', '{}\n');

  const registry = new SkillRegistry(join(root, 'registry.yaml'));
  const registrySource = { url: 'git@example.test/agent-skills.git', revision: 'a1b2c3d4' };
  const methodSource = createSkillLock('x').methodSources[0]!;
  await registry.replace({ profiles: [], skills: [
    { name: 'requirements-clarification', version: '1.0.0', description: '澄清', aiwCompatibility: '>=0.0.1 <1.0.0', artifactContract: 'aiw.task-output/v1', phases: ['clarify'], methodSources: [methodSource], body: '澄清需求。', registrySource, sha256: 'a'.repeat(64) },
    { name: 'design-image-segmentation', version: '1.0.0', description: '设计图片切割与绑定', aiwCompatibility: '>=0.0.1 <1.0.0', artifactContract: 'aiw.task-output/v1', phases: ['design'], methodSources: [methodSource], body: '切割并绑定设计图片。', registrySource, sha256: 'a'.repeat(64) },
    { name: 'typescript-web-implementation', version: '1.0.0', description: '开发', aiwCompatibility: '>=0.0.1 <1.0.0', artifactContract: 'aiw.task-output/v1', phases: ['development'], methodSources: [methodSource], body: '开发代码。', registrySource, sha256: 'a'.repeat(64) },
  ], methods: [{ source: methodSource, content: '理解问题。', registrySource }] });

  const prompts: string[] = [];
  const adapter = new CodexAdapter({ processRunner: { async run(input) {
    prompts.push(input.stdin);
    const taskRoot = join(input.cwd, '.aiw/tasks/refund-123/runs/run-1/staging');
    if (mode === 'design' || mode === 'design-invalid') {
      const directory = join(taskRoot, 'artifacts/design'); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'design-assets.yaml'), stringify({ schemaVersion: 'aiw.design-assets/v1', source: { provider: 'local-images', images: [{ id: 'main', originalName: 'main.png', imagePath: 'sources/design/main.png', mediaType: 'image/png' }] }, coverage: { sourceImageCount: 1, logicalBlockCount: 1 }, assets: [{ id: 'refund-flow-block', sourceImageId: 'main', title: '退款流程', kind: 'block', imagePath: 'artifacts/design/assets/refund-flow-block.png', purpose: '退款入口布局', developmentUnits: [mode === 'design' ? 'development-unit-refund-entry' : 'development-unit-missing'] }] }));
      const assetDirectory = join(input.cwd, '.aiw/tasks/refund-123/artifacts/design/assets'); await mkdir(assetDirectory, { recursive: true });
      await writeFile(join(assetDirectory, 'refund-flow-block.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'));
    } else if (mode === 'development' || mode === 'development-no-changes') {
      const path = join(taskRoot, 'artifacts/development/development-unit-refund-entry/result.md'); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '# 开发结果\n\n## 完成的代码修改\n\n已实现退款入口。\n\n## 变更文件\n\n- src/refund.ts\n\n## 未解决问题\n\n无。\n\n## 已知风险\n\n无。\n');
    } else {
      const fact = join(taskRoot, 'artifacts/clarify/fact-register.yaml'); await mkdir(dirname(fact), { recursive: true });
      await writeFile(fact, stringify({ schemaVersion: 'aiw.fact-register/v2', facts: [{ statement: '用户可以申请退款。', source: { type: 'requirement', path: 'sources/requirements/r1/snapshot.md' } }] }));
      if (mode !== 'missing-decision') await writeFile(join(taskRoot, 'artifacts/clarify/decision-register.yaml'), stringify({ schemaVersion: 'aiw.decision-register/v2', pendingDecisions: [], currentDecisions: [], deferredItems: [] }));
    }
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
  } } });
  const changeInspector = { async changedPaths() { return []; }, async untrackedPaths() { return []; }, async diff() { return ''; }, async revision() { return { head: 'abc', branch: 'main' }; } };
  const taskFactGuard = new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'developer'; } } });
  const runner = new TaskRunner({
    taskStore: store, skillRegistry: registry, methodSourceResolver: new MethodSourceResolver(registry),
    contextBuilder: new ContextBuilder({ taskDirectory: (value) => store.taskDirectory(value.id), projectRoot: () => root, maxTokens: 20_000 }),
    taskFactGuard, changeInspector, adapter,
    deliveryWorkspaceManager: { async prepare() { return { projectRoot: root, sourceHead: 'abc', async publish() { const changedPaths = mode === 'development' ? ['src/refund.ts'] : []; return { published: changedPaths.length > 0, patch: '', patchSha256: '0'.repeat(64), changedPaths }; }, async rollback() {}, async dispose() {} }; } },
    runtimeRoot, runIdFactory: () => 'run-1',
  });
  return { runner, store, prompts, runtimeRoot };
}
