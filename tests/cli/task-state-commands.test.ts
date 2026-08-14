import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

import { createTaskStateCommand, TaskStateCommands } from '../../src/cli/task-state-commands.js';
import { TaskFactGuard } from '../../src/services/task-fact-guard.js';
import { TaskStore } from '../../src/services/task-store.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

describe('TaskStateCommands', () => {
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('writes an approval bound to the current output hashes before unlocking the downstream node', async () => {
    const { store, directory } = await createApprovalTask('clarify');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await commands.approve('refund-123', 'clarify', { note: '验收标准完整' });

    const approval = parse(await readFile(join(directory, 'approvals', 'clarify', 'r1.yaml'), 'utf8'));
    expect(approval).toMatchObject({ decision: 'approved', actor: 'tech-lead', nodeId: 'clarify', nodeRevision: 1 });
    expect(approval.artifactHashes).toMatchObject({ 'artifacts/brief.md': `sha256:${createHash('sha256').update('# artifacts/brief.md\n').digest('hex')}` });
    expect((await store.load('refund-123')).nodes.solution.status).toBe('ready');
  });

  it('rejects approval when the node has no complete run evidence package', async () => {
    const { store } = await createApprovalTask('clarify', { completionBundle: false });
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'tech-lead'; } } }),
    });

    await expect(commands.approve('refund-123', 'clarify', { note: '验收标准完整' }))
      .rejects.toThrow('缺少可提交的完成运行包');
  });

  it('records changes requested with a next revision instruction', async () => {
    const { store, directory } = await createApprovalTask('plan');
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; } } }),
    });

    await commands.requestChanges('refund-123', 'plan', { actor: 'tech-lead', note: '补充回滚方案' });

    await expect(readFile(join(directory, 'revisions', 'plan', 'r2.md'), 'utf8')).resolves.toContain('补充回滚方案');
    expect((await store.load('refund-123')).nodes.plan.status).toBe('ready');
  });

  it('marks an interrupted running node as failed with an auditable reason', async () => {
    const { store } = await createApprovalTask('clarify');
    const task = await store.load('refund-123');
    task.nodes.clarify.status = 'running';
    await store.update(task);
    const commands = new TaskStateCommands({
      taskStore: store,
      taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'developer'; } } }),
    });

    await commands.fail('refund-123', 'clarify', { note: 'Codex CLI 参数冲突导致进程中断' });

    const failed = await store.load('refund-123');
    expect(failed.nodes.clarify.status).toBe('failed');
    expect(failed.events.at(-1)).toMatchObject({ type: 'fail', nodeId: 'clarify', actor: 'developer', reason: 'Codex CLI 参数冲突导致进程中断' });
  });

  it('rejects a skill rebind when the installed skill does not support the target phase', async () => {
    const { store, directory } = await createApprovalTask('plan');
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    await registry.replace({
      skills: [{
        name: 'clarify-only', version: '1.0.0', description: 'clarify only', phases: ['clarify'], body: '# skill', registrySource: { url: 'https://example.test/skills.git', revision: 'abc123' }, sha256: 'a'.repeat(64), methodSources: [],
      }],
      profiles: [],
    });
    const task = await store.load('refund-123');
    task.nodes.plan.status = 'ready';
    await store.update(task);
    const commands = new TaskStateCommands({ taskStore: store, taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; } } }), skillRegistry: registry });

    await expect(commands.rebindSkill('refund-123', 'plan', { skill: 'clarify-only@1.0.0', note: '错误映射' }))
      .rejects.toThrow('技能与节点阶段不兼容');
  });

  it('adds an implementation subtask with explicit dependency, approval and verify merge edge', async () => {
    const { store } = await createApprovalTask('plan');
    const task = await store.load('refund-123');
    task.nodes.plan.status = 'completed';
    task.nodes.implement.status = 'pending';
    task.nodes.verify.status = 'pending';
    await store.update(task);
    const commands = new TaskStateCommands({ taskStore: store, taskFactGuard: new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; } } }) });

    const updated = await commands.addSubtask('refund-123', 'implement-export', {
      title: '实现导出文件名', dependsOn: ['plan'], before: ['verify'], requiresApproval: true,
    });

    expect(updated.nodes['implement-export']).toMatchObject({ phase: 'implement', dependsOn: ['plan'], status: 'ready', requiresApproval: true, outputs: ['artifacts/subtasks/implement-export.md'] });
    expect(updated.nodes.verify.dependsOn).toEqual(['implement', 'implement-export']);
    expect(updated.events.at(-1)).toMatchObject({ type: 'add_subtask', nodeId: 'implement-export' });
  });

  it('tells users to commit a requested change before rerunning the ready node', async () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'completed';
    task.nodes.plan.status = 'ready';
    let output = '';
    const command = createTaskStateCommand({
      commands: { async requestChanges() { return task; } } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'task', 'request-changes', 'refund-123', 'plan', '--note', '补充范围']);

    expect(output).toContain('1. git add .aiw && git commit -m "chore(aiw): record plan changes"');
    expect(output).toContain('2. aiw task run refund-123 plan');
  });
});

async function createApprovalTask(nodeId: 'clarify' | 'plan', options: { completionBundle?: boolean } = {}): Promise<{ store: TaskStore; directory: string }> {
  const directory = await createTempDirectory('aiw-task-state-');
  directories.push(directory);
  const store = new TaskStore(directory);
  const task = createSevenPhaseTask();
  if (nodeId === 'plan') {
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'completed';
  }
  task.nodes[nodeId].status = 'awaiting_approval';
  task.nodes[nodeId].revision = 1;
  await store.create(task);
  const taskDirectory = store.taskDirectory(task.id);
  await mkdir(join(taskDirectory, 'artifacts'), { recursive: true });
  for (const output of task.nodes[nodeId].outputs) {
    await writeFile(join(taskDirectory, output), `# ${output}\n`, 'utf8');
  }
  if (options.completionBundle !== false) {
    const runId = `${nodeId}-run-1`;
    task.events.push({
      type: 'succeed', nodeId, at: '2026-08-14T00:00:00.000Z', runId,
      outputs: task.nodes[nodeId].outputs.map((path) => ({ path, sha256: createHash('sha256').update(`# ${path}\n`).digest('hex') })),
      evidencePath: `runs/${runId}/change-evidence.json`,
    });
    await store.update(task);
    for (const path of ['context-manifest.json', 'change-baseline.json', 'change-scope.json', 'change-evidence.json', 'change-diff.json', 'change.patch', 'result.json']) {
      await store.createFact('refund-123', `runs/${runId}/${path}`, '{}\n');
    }
  }
  return { store, directory: taskDirectory };
}
