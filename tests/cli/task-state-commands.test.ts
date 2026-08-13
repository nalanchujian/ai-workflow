import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

import { TaskStateCommands } from '../../src/cli/task-state-commands.js';
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
});

async function createApprovalTask(nodeId: 'clarify' | 'plan'): Promise<{ store: TaskStore; directory: string }> {
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
  return { store, directory: taskDirectory };
}
