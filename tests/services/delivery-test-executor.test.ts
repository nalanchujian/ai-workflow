import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

import { DeliveryTestExecutor, deliveryTestPlan } from '../../src/services/delivery-test-executor.js';
import { nextArtifactPath } from '../../src/domain/handoff.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

describe('DeliveryTestExecutor', () => {
  it('runs the approved command itself and records immutable stdout/stderr evidence', async () => {
    const root = await createTempDirectory('aiw-delivery-test-');
    directories.push(root);
    const store = new TaskStore(root);
    const task = createSevenPhaseTask();
    task.repository = root;
    task.nodes.implement = { ...task.nodes.implement!, generatedFromPlan: true, workUnitId: 'refund', acceptanceRefs: ['AC-01'], verificationCommands: ['pnpm test -- refund'] };
    await store.create(task);

    const results = await new DeliveryTestExecutor({
      processRunner: {
        async run(input) {
          expect(input.command).toBe('pnpm');
          expect(input.args).toEqual(['test', '--', 'refund']);
          return { exitCode: 0, signal: null, stdout: '1 passed\n', stderr: '', timedOut: false };
        },
      },
    }).execute({ task, nodeId: 'implement', node: task.nodes.implement!, runId: 'run-1', taskStore: store, projectRoot: root });

    expect(deliveryTestPlan(task.nodes.implement!)).toEqual([{ id: 'TEST-REFUND-01', command: 'pnpm test -- refund' }]);
    expect(results.items[0]).toMatchObject({ id: 'TEST-REFUND-01', status: 'passed', exitCode: 0, evidencePath: 'runs/run-1/tests/TEST-REFUND-01.json' });
    const evidence = await readFile(join(store.taskDirectory(task.id), results.items[0]!.evidencePath));
    expect(results.items[0]!.evidenceSha256).toBe(createHash('sha256').update(evidence).digest('hex'));
    const outputPath = nextArtifactPath('implement', task.nodes.implement!, 'artifacts/test-results.yaml');
    expect(parse(await readFile(join(store.taskDirectory(task.id), outputPath), 'utf8'))).toMatchObject({ runId: 'run-1', items: [{ id: 'TEST-REFUND-01', status: 'passed', exitCode: 0 }] });
  });

  it('records shell syntax as blocked rather than executing an arbitrary shell expression', async () => {
    const root = await createTempDirectory('aiw-delivery-test-');
    directories.push(root);
    const store = new TaskStore(root);
    const task = createSevenPhaseTask();
    task.repository = root;
    task.nodes.implement = { ...task.nodes.implement!, generatedFromPlan: true, workUnitId: 'refund', acceptanceRefs: ['AC-01'], verificationCommands: ['pnpm test && rm -rf tmp'] };
    await store.create(task);
    let called = false;

    const results = await new DeliveryTestExecutor({
      processRunner: { async run() { called = true; return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; } },
    }).execute({ task, nodeId: 'implement', node: task.nodes.implement!, runId: 'run-1', taskStore: store, projectRoot: root });

    expect(called).toBe(false);
    expect(results.items[0]).toMatchObject({ status: 'blocked', exitCode: null });
  });
});
