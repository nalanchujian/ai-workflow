import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import { ContextBuilder } from '../../src/services/context-builder.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { TaskRunner } from '../../src/services/task-runner.js';
import { TaskStore } from '../../src/services/task-store.js';
import { ExecutableNotFoundError } from '../../src/ports/process-runner.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTempDirectory));
});

describe('TaskRunner', () => {
  it('creates a dry-run context with the locked method and never starts Codex', async () => {
    const fixture = await createRunnerFixture({ exitCode: 0 });

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: true, includes: [] });

    expect(result.status).toBe('succeeded');
    expect(fixture.processCalls).toHaveLength(0);
    expect(await readFile(join(result.runDirectory, 'context.md'), 'utf8')).toContain('<method-source id="superpowers:brainstorming" trust="lower-priority-guidance">');
    expect((await fixture.taskStore.load('refund-123')).nodes.clarify?.status).toBe('ready');
  });

  it('marks the node as failed when Codex is unavailable', async () => {
    const fixture = await createRunnerFixture({ missingExecutable: true });

    const result = await fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: false, includes: [] });

    expect(result.status).toBe('unavailable');
    expect((await fixture.taskStore.load('refund-123')).nodes.clarify?.status).toBe('failed');
  });

  it('rejects a run when another process holds the task execution lock', async () => {
    const fixture = await createRunnerFixture({
      runLock: { async acquire() { return undefined; } },
    });

    await expect(fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: true, includes: [] }))
      .rejects.toMatchObject({ code: 'TASK_BUSY' });
    expect(fixture.processCalls).toHaveLength(0);
  });

  it('counts the locked skill and method content in the run budget', async () => {
    const fixture = await createRunnerFixture({ maxTokens: 10 });

    await expect(fixture.runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: true, includes: [] }))
      .rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' });
  });

  it('rejects a blocked downstream node before invoking Codex', async () => {
    const fixture = await createRunnerFixture({});

    await expect(fixture.runner.run({ taskId: 'refund-123', nodeId: 'solution', dryRun: false, includes: [] }))
      .rejects.toMatchObject({ code: 'NODE_NOT_RUNNABLE' });
    expect(fixture.processCalls).toHaveLength(0);
  });
});

async function createRunnerFixture(options: {
  exitCode?: number;
  missingExecutable?: boolean;
  maxTokens?: number;
  runLock?: { acquire(input: { taskId: string }): Promise<undefined> };
}) {
  const projectRoot = await temporaryDirectory();
  const taskStore = new TaskStore(projectRoot);
  const task = createSevenPhaseTask();
  task.repository = projectRoot;
  await taskStore.create(task);
  await writeFile(join(taskStore.taskDirectory(task.id), 'task.md'), '# 退款需求\n', 'utf8');

  const registry = new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml'));
  const skill = task.nodes.clarify?.skill;
  if (skill === undefined) {
    throw new Error('fixture skill missing');
  }
  await registry.replace({
    skills: [{
      name: skill.name,
      version: skill.version,
      description: '澄清需求',
      phases: ['clarify'],
      registrySource: skill.registrySource,
      sha256: skill.sha256,
      methodSources: skill.methodSources,
      body: '澄清需求并输出 brief。',
    }],
    profiles: [],
  });

  const processCalls: unknown[] = [];
  const adapter = new CodexAdapter({
    processRunner: {
      async run(input) {
        processCalls.push(input);
        if (options.missingExecutable) {
          throw new ExecutableNotFoundError('codex');
        }
        return { exitCode: options.exitCode ?? 0, signal: null, stdout: '', stderr: '', timedOut: false };
      },
    },
  });
  const runner = new TaskRunner({
    taskStore,
    skillRegistry: registry,
    methodSourceResolver: {
      async resolve() { throw new Error('not used'); },
      async assertLocked() {},
      async readLocked(source) { return { source, content: '先理解问题。' }; },
    },
    contextBuilder: new ContextBuilder({ taskDirectory: (input) => taskStore.taskDirectory(input.id), projectRoot: (input) => input.repository, maxTokens: options.maxTokens }),
    taskFactGuard: { async assertCommitted() {}, async actor() { return 'tester'; } } as never,
    adapter,
    runtimeRoot: join(projectRoot, '.aiw-runtime'),
    runIdFactory: () => 'run-1',
    ...(options.runLock === undefined ? {} : { runLock: options.runLock }),
  });
  return { runner, taskStore, processCalls };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await createTempDirectory('aiw-task-runner-');
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}
