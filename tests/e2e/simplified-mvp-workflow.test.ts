import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import { TaskStateCommands } from '../../src/cli/task-state-commands.js';
import { ContextBuilder } from '../../src/services/context-builder.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { TaskDecisionService } from '../../src/services/task-decision-service.js';
import { TaskFactGuard } from '../../src/services/task-fact-guard.js';
import { TaskRunner } from '../../src/services/task-runner.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask, createSkillLock } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

describe('simplified MVP workflow', () => {
  it('moves from clarification to dependent development units and completes development', async () => {
    const fixture = await setup();

    await fixture.runner.run({ taskId: fixture.taskId, nodeId: 'requirement-analysis', dryRun: false, includes: [] });
    await fixture.runner.run({ taskId: fixture.taskId, nodeId: 'solution', dryRun: false, includes: [] });
    await fixture.runner.run({ taskId: fixture.taskId, nodeId: 'plan', dryRun: false, includes: [] });
    let task = await fixture.store.load(fixture.taskId);

    expect(task.nodes['development-unit-refund-entry']?.status).toBe('ready');
    expect(task.nodes['development-unit-refund-form']).toMatchObject({ status: 'pending', dependsOn: ['development-unit-refund-entry'] });

    await fixture.runner.run({ taskId: fixture.taskId, nodeId: 'development-unit-refund-entry', dryRun: false, includes: [] });
    task = await fixture.store.load(fixture.taskId);
    expect(task.nodes['development-unit-refund-form']?.status).toBe('ready');

    await fixture.runner.run({ taskId: fixture.taskId, nodeId: 'development-unit-refund-form', dryRun: false, includes: [] });
    task = await fixture.store.load(fixture.taskId);
    expect(task.status).toBe('completed');
    expect(Object.values(task.nodes).filter((node) => node.phase === 'development').every((node) => node.status === 'completed')).toBe(true);
    expect(task.nodes).not.toHaveProperty('verify');
    expect(task.nodes).not.toHaveProperty('test');
  });

  it('cuts a local image before solution and resolves planned bindings when materializing units', async () => {
    const fixture = await setup(true);

    await fixture.runner.run({ taskId: fixture.taskId, nodeId: 'requirement-analysis', dryRun: false, includes: [] });
    const result = await fixture.runner.run({ taskId: fixture.taskId, nodeId: 'design-slicing', dryRun: false, includes: [] });
    await fixture.runner.run({ taskId: fixture.taskId, nodeId: 'solution', dryRun: false, includes: [] });
    await fixture.runner.run({ taskId: fixture.taskId, nodeId: 'plan', dryRun: false, includes: [] });
    const task = await fixture.store.load(fixture.taskId);

    expect(result.status).toBe('succeeded');
    expect(task.nodes['design-slicing']?.status).toBe('completed');
    expect(task.nodes['development-unit-refund-entry']?.status).toBe('ready');
    await expect(readFile(join(fixture.store.taskDirectory(task.id), 'artifacts/plan/units/development-unit-refund-entry.yaml'), 'utf8')).resolves.toContain('assetId: refund-flow-block');
    await expect(readFile(join(fixture.store.taskDirectory(task.id), 'artifacts/design/design-assets.yaml'), 'utf8')).resolves.toContain('aiw.design-assets/v2');
    await expect(readFile(join(fixture.store.taskDirectory(task.id), 'artifacts/design/assets/refund-flow-block.png'))).resolves.toBeInstanceOf(Buffer);
  });
});

async function setup(withDesign = false) {
  const root = await createTempDirectory('aiw-e2e-simplified-');
  directories.push(root);
  const store = new TaskStore(root);
  const task = createSevenPhaseTask();
  task.repository = root;
  task.inputs.apiDocuments = { status: 'absent' };
  task.inputs.design = { status: 'absent' };
  task.sources.requirements = {
    kind: 'local-file', origin: 'requirements.md', revision: 1,
    snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json',
  };
  if (withDesign) {
    task.inputs.design = { status: 'provided', image: { id: 'refund-design', originalName: 'refund-design.png', imagePath: 'sources/design/refund-design.png', mediaType: 'image/png' } };
    task.nodes.solution.dependsOn = ['design-slicing'];
    task.nodes['design-slicing'] = { title: '设计图切割', phase: 'design-slicing', dependsOn: ['requirement-analysis'], skills: [createSkillLock('design-slicing')], requiresApproval: false, status: 'pending', hasResult: false, outputs: ['artifacts/design/design-assets.yaml'] };
  }
  await store.create(task);
  await store.replaceFact(task.id, task.sources.requirements.snapshotPath, '# 需求\n\n增加退款入口和退款表单。\n');
  await store.replaceFact(task.id, task.sources.requirements.metaPath, '{}\n');
  if (withDesign) await store.replaceBinaryFact(task.id, 'sources/design/refund-design.png', Buffer.from('89504e470d0a1a0a00000000', 'hex'));

  const registry = new SkillRegistry(join(root, 'registry.yaml'));
  const registrySource = task.skillProfile.registrySource;
  const skill = (name: string, phase: 'design-slicing' | 'requirement-analysis' | 'solution' | 'plan' | 'development') => ({
    name, version: '1.0.0', description: name, aiwCompatibility: '>=0.0.1 <1.0.0' as const,
    artifactContract: 'aiw.task-output/v2' as const, phases: [phase],
    body: `# ${name}\n\n## 输入\n\n输入。\n\n## 步骤\n\n1. 执行。\n\n## 输出\n\n输出。`,
    registrySource, sha256: 'a'.repeat(64),
  });
  await registry.replace({
    profiles: [],
    skills: [
      skill('design-slicing', 'design-slicing'),
      skill('requirement-analysis', 'requirement-analysis'), skill('technical-solution', 'solution'),
      skill('implementation-planning', 'plan'), skill('typescript-web-implementation', 'development'),
    ],
  });

  let runNumber = 0;
  const adapter = new CodexAdapter({ processRunner: { async run(input) {
    const stagingRoot = stagingRootFrom(input.stdin, input.cwd);
    if (input.stdin.includes('<artifact-protocol id="design-assets"')) {
      await write(stagingRoot, 'artifacts/design/design-assets.yaml', stringify({ schemaVersion: 'aiw.design-assets/v2', source: { image: task.inputs.design.status === 'provided' ? task.inputs.design.image : undefined }, sourceSize: { width: 800, height: 600 }, assets: [{ id: 'refund-flow-block', sourceImageId: 'refund-design', title: '退款流程', imagePath: 'artifacts/design/assets/refund-flow-block.png', crop: { x: 0, y: 0, width: 800, height: 600 } }] }));
      await mkdir(join(input.cwd, '.aiw/tasks/refund-123/artifacts/design/assets'), { recursive: true });
      await writeFile(join(input.cwd, '.aiw/tasks/refund-123/artifacts/design/assets/refund-flow-block.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'));
    } else if (input.stdin.includes('需求分析只读取本次需求文档快照')) {
      await write(stagingRoot, 'artifacts/requirement-analysis/fact-register.yaml', stringify({
        schemaVersion: 'aiw.fact-register/v3',
        facts: [{ statement: '需要增加退款入口和退款表单。', source: { type: 'requirement', path: 'sources/requirements/r1/snapshot.md' } }],
      }));
      await write(stagingRoot, 'artifacts/requirement-analysis/decision-register.yaml', stringify({ schemaVersion: 'aiw.decision-register/v2', pendingDecisions: [], currentDecisions: [], deferredItems: [] }));
    } else if (input.stdin.includes('生成技术方案')) {
      await write(stagingRoot, 'artifacts/solution/solution.md', '# 技术方案\n\n## 方案结论\n\n复用现有页面结构。\n\n## 架构与接口影响\n\n新增退款模块。\n\n## 风险与待决事项\n\n无。\n');
    } else if (input.stdin.includes('拆成可独立开发的业务单元')) {
      await write(stagingRoot, 'artifacts/plan/development-plan.yaml', stringify({
        schemaVersion: 'aiw.development-plan/v2',
        units: [
          { name: 'development-unit-refund-entry', title: '退款入口', goal: '增加退款入口', requirements: ['展示入口'], codeScope: ['src/refund'], steps: ['实现入口'], dependencies: [], designReferences: withDesign ? [{ assetId: 'refund-flow-block', purpose: '退款入口布局' }] : [] },
          { name: 'development-unit-refund-form', title: '退款表单', goal: '增加退款表单', requirements: ['提交原因'], codeScope: ['src/refund-form'], steps: ['实现表单'], dependencies: ['development-unit-refund-entry'] },
        ],
      }));
    } else {
      const output = /runs\/[^/]+\/staging\/(artifacts\/development\/[^\s]+\/result\.md)/.exec(input.stdin)?.[1];
      if (output === undefined) throw new Error('未找到开发结果暂存路径');
      await write(stagingRoot, output, '# 开发结果\n\n## 完成的代码修改\n\n已完成当前单元代码。\n\n## 变更文件\n\n- src/example.ts\n\n## 未解决问题\n\n无。\n\n## 已知风险\n\n无。\n');
    }
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
  } } });
  const repository = {
    async uncommittedPaths() { return []; }, async authorName() { return 'developer'; },
  };
  const taskFactGuard = new TaskFactGuard({ repositoryStatus: repository });
  const runner = new TaskRunner({
    taskStore: store, skillRegistry: registry,
    contextBuilder: new ContextBuilder({ taskDirectory: (value) => store.taskDirectory(value.id), projectRoot: () => root, maxTokens: 20_000 }),
    taskFactGuard,
    changeInspector: { async changedPaths() { return []; }, async untrackedPaths() { return []; }, async diff() { return ''; }, async revision() { return { head: 'abc', branch: 'main' }; } },
    deliveryWorkspaceManager: {
      async prepare() {
        return {
          projectRoot: root,
          sourceHead: 'abc',
          async publish() { return { published: true, patch: '', patchSha256: '0'.repeat(64), changedPaths: ['src/example.ts'] }; },
          async rollback() {},
          async dispose() {},
        };
      },
    },
    adapter, runtimeRoot: join(root, '.runtime'), runIdFactory: () => `run-${++runNumber}`,
  });
  const commands = new TaskStateCommands({ taskStore: store, taskFactGuard, decisionService: new TaskDecisionService({ taskStore: store }) });
  return { runner, commands, store, taskId: task.id };
}

function stagingRootFrom(prompt: string, cwd: string): string {
  const match = /runs\/([^/]+)\/staging\//.exec(prompt);
  if (match === null) throw new Error('未找到运行暂存目录');
  return join(cwd, '.aiw', 'tasks', 'refund-123', 'runs', match[1]!, 'staging');
}

async function write(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}
