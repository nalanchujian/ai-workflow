import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { HandoffMigrator } from '../../src/services/handoff-migrator.js';
import { TaskStore } from '../../src/services/task-store.js';
import { handoffPath } from '../../src/domain/handoff.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

describe('HandoffMigrator', () => {
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('uses Codex to backfill completed node handoffs without modifying business files', async () => {
    const projectRoot = await createTempDirectory('aiw-handoff-migrator-');
    directories.push(projectRoot);
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();
    task.nodes.intake.revision = 1;
    for (const nodeId of ['clarify', 'solution', 'plan', 'implement', 'verify']) {
      task.nodes[nodeId]!.status = 'completed';
      task.nodes[nodeId]!.revision = 1;
    }
    task.nodes.test.status = 'ready';
    task.sources.requirements = {
      kind: 'connected-document', origin: 'https://example.test/docx/requirements', externalId: 'requirements', revision: 1,
      snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json', contentSha256: 'a'.repeat(64),
    };
    await store.create(task);
    for (const node of Object.values(task.nodes)) {
      for (const output of node.outputs) {
        await writeFact(store, task.id, output, `# ${output}\n\n已完成历史产物。\n`);
      }
    }
    await writeFact(store, task.id, task.sources.requirements.snapshotPath, '# 历史需求\n\n退款功能。\n');
    await writeFact(store, task.id, task.sources.requirements.metaPath, '{}\n');

    const calls: Array<{ nodeId: string; paths: string[] }> = [];
    const migrator = new HandoffMigrator({
      taskStore: store,
      runtimeRoot: join(projectRoot, '.runtime'),
      adapter: {
        async run(request) {
          calls.push({ nodeId: request.task.nodeId, paths: request.context.files.map((file) => file.path) });
          const node = task.nodes[request.task.nodeId]!;
          const output = request.artifacts[0]!;
          await writeFact(store, task.id, output, handoff(task.id, request.task.nodeId, node.phase, node.revision, node.outputs[0]!));
          return { schemaVersion: 'aiw.run-result/v1', runId: request.runId, status: 'succeeded', runDirectory: request.runDirectory, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), artifacts: [] };
        },
      },
      taskFactGuard: { async assertCommitted() {} } as never,
      changeInspector: { async changedPaths() { return []; } },
      runIdFactory: () => 'migration-1',
    });

    const result = await migrator.migrate({ taskId: task.id });

    expect(calls.map((call) => call.nodeId)).toEqual(['clarify', 'solution', 'plan', 'implement', 'verify']);
    expect(calls.find((call) => call.nodeId === 'solution')?.paths).toEqual([
      'artifacts/brief.md',
      'artifacts/solution.md',
    ]);
    expect(calls.find((call) => call.nodeId === 'verify')?.paths).toEqual([
      'artifacts/implementation.md',
      'artifacts/verification.md',
    ]);
    expect(result.migratedNodeIds).toEqual(['intake', 'clarify', 'solution', 'plan', 'implement', 'verify']);
    for (const nodeId of result.migratedNodeIds) {
      await expect(readFile(join(store.taskDirectory(task.id), handoffPath(nodeId, task.nodes[nodeId]!.revision)), 'utf8')).resolves.toContain(`nodeId: ${nodeId}`);
    }
    const taskRoot = relative(projectRoot, store.taskDirectory(task.id));
    expect(result.auditPaths).toContain(`migrations/handoffs/migration-1/verify.json`);
    expect((await store.load(task.id)).events).toContainEqual(expect.objectContaining({ type: 'migrate_handoff', nodeId: 'verify' }));
    expect(taskRoot).toBe('.aiw/tasks/refund-123');
  });
});

async function writeFact(store: TaskStore, taskId: string, path: string, content: string): Promise<void> {
  await mkdir(join(store.taskDirectory(taskId), path, '..'), { recursive: true });
  await writeFile(join(store.taskDirectory(taskId), path), content, 'utf8');
}

function handoff(taskId: string, nodeId: string, phase: string, revision: number, evidencePath: string): string {
  return `schemaVersion: aiw.handoff/v1\ntaskId: ${taskId}\nnodeId: ${nodeId}\nphase: ${phase}\nrevision: ${revision}\nsummary: 已根据历史任务事实补齐结构化交接结论。\nfacts:\n  - id: FACT-01\n    statement: 历史节点产物已保留并可供后续追溯。\n    evidence:\n      - path: ${evidencePath}\ndecisions: []\nacceptance: []\nchanges: []\nverification: []\nopenRisks: []\n`;
}
