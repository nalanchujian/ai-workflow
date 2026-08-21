import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import { TaskStateCommands } from '../../src/cli/task-state-commands.js';
import { ContextBuilder } from '../../src/services/context-builder.js';
import { MethodSourceResolver } from '../../src/services/method-source-resolver.js';
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

    await fixture.runner.run({ taskId: fixture.taskId, nodeId: 'clarify', dryRun: false, includes: [] });
    await fixture.commands.reviewClarify(fixture.taskId, [], { note: '需求确认' });
    await fixture.runner.run({ taskId: fixture.taskId, nodeId: 'solution', dryRun: false, includes: [] });
    await fixture.runner.run({ taskId: fixture.taskId, nodeId: 'plan', dryRun: false, includes: [] });
    let task = await fixture.commands.approve(fixture.taskId, 'plan', { note: '计划确认' });

    expect(task.nodes['development-unit-1']?.status).toBe('ready');
    expect(task.nodes['development-unit-2']).toMatchObject({ status: 'pending', dependsOn: ['development-unit-1'] });

    await fixture.runner.run({ taskId: fixture.taskId, nodeId: 'development-unit-1', dryRun: false, includes: [] });
    task = await fixture.store.load(fixture.taskId);
    expect(task.nodes['development-unit-2']?.status).toBe('ready');

    await fixture.runner.run({ taskId: fixture.taskId, nodeId: 'development-unit-2', dryRun: false, includes: [] });
    task = await fixture.store.load(fixture.taskId);
    expect(task.status).toBe('completed');
    expect(Object.values(task.nodes).filter((node) => node.phase === 'development').every((node) => node.status === 'completed')).toBe(true);
    expect(task.nodes).not.toHaveProperty('verify');
    expect(task.nodes).not.toHaveProperty('test');
  });
});

async function setup() {
  const root = await createTempDirectory('aiw-e2e-simplified-');
  directories.push(root);
  const store = new TaskStore(root);
  const task = createSevenPhaseTask();
  task.repository = root;
  task.sources.requirements = {
    kind: 'local-file', origin: 'requirements.md', revision: 1,
    snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json',
  };
  task.nodes.intake!.outputs = ['sources/requirements/r1/snapshot.md', 'sources/requirements/r1/meta.json'];
  await store.create(task);
  await store.replaceFact(task.id, task.sources.requirements.snapshotPath, '# 需求\n\n增加退款入口和退款表单。\n');
  await store.replaceFact(task.id, task.sources.requirements.metaPath, '{}\n');

  const registry = new SkillRegistry(join(root, 'registry.yaml'));
  const registrySource = task.skillProfile.registrySource;
  const methodSource = createSkillLock('unused').methodSources[0]!;
  const skill = (name: string, phase: 'clarify' | 'solution' | 'plan' | 'development') => ({
    name, version: '1.0.0', description: name, aiwCompatibility: '>=0.0.1 <1.0.0' as const,
    artifactContract: 'aiw.task-output/v1' as const, phases: [phase], methodSources: [methodSource],
    body: `# ${name}\n\n## 输入\n\n输入。\n\n## 步骤\n\n1. 执行。\n\n## 输出\n\n输出。`,
    registrySource, sha256: 'a'.repeat(64),
  });
  await registry.replace({
    profiles: [],
    skills: [
      skill('requirements-clarification', 'clarify'), skill('technical-solution', 'solution'),
      skill('implementation-planning', 'plan'), skill('typescript-web-implementation', 'development'),
    ],
    methods: [{ source: methodSource, content: '# 方法\n', registrySource }],
  });

  let runNumber = 0;
  const adapter = new CodexAdapter({ processRunner: { async run(input) {
    const stagingRoot = stagingRootFrom(input.stdin, input.cwd);
    if (input.stdin.includes('澄清阶段只生成事实登记和决策登记')) {
      await write(stagingRoot, 'artifacts/clarify/fact-register.yaml', stringify({
        schemaVersion: 'aiw.fact-register/v2',
        facts: [{ statement: '需要增加退款入口和退款表单。', source: { type: 'requirement', path: 'sources/requirements/r1/snapshot.md' } }],
      }));
      await write(stagingRoot, 'artifacts/clarify/decision-register.yaml', stringify({ schemaVersion: 'aiw.decision-register/v2', pendingDecisions: [], currentDecisions: [], deferredItems: [] }));
    } else if (input.stdin.includes('生成技术方案')) {
      await write(stagingRoot, 'artifacts/solution/solution.md', '# 技术方案\n\n## 方案结论\n\n复用现有页面结构。\n\n## 架构与接口影响\n\n新增退款模块。\n\n## 风险与待决事项\n\n无。\n');
    } else if (input.stdin.includes('拆成可独立开发的业务单元')) {
      await write(stagingRoot, 'artifacts/plan/development-plan.yaml', stringify({
        schemaVersion: 'aiw.development-plan/v1',
        units: [
          { title: '退款入口', goal: '增加退款入口', requirements: ['展示入口'], codeScope: ['src/refund'], steps: ['实现入口'], dependencies: [] },
          { title: '退款表单', goal: '增加退款表单', requirements: ['提交原因'], codeScope: ['src/refund-form'], steps: ['实现表单'], dependencies: ['退款入口'] },
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
    taskStore: store, skillRegistry: registry, methodSourceResolver: new MethodSourceResolver(registry),
    contextBuilder: new ContextBuilder({ taskDirectory: (value) => store.taskDirectory(value.id), projectRoot: () => root, maxTokens: 20_000 }),
    taskFactGuard,
    changeInspector: { async changedPaths() { return []; }, async untrackedPaths() { return []; }, async diff() { return ''; }, async revision() { return { head: 'abc', branch: 'main' }; } },
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
