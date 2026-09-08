import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { TaskCancellationService } from '../../src/services/task-cancellation-service.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

describe('TaskCancellationService', () => {
  it('records a cancellation request and terminates the active Codex process', async () => {
    const projectRoot = await createTempDirectory('aiw-cancel-');
    directories.push(projectRoot);
    const runtimeRoot = join(projectRoot, '.aiw-runtime');
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();
    task.nodes['requirement-analysis'].status = 'running';
    task.events.push({ type: 'start', nodeId: 'requirement-analysis', at: '2026-08-14T00:00:00.000Z', runId: 'run-1' });
    await store.create(task);
    await mkdir(join(runtimeRoot, task.id, 'run-1'), { recursive: true });
    await writeFile(join(runtimeRoot, task.id, 'run-1', 'process.json'), '{"pid":12345}\n', 'utf8');
    const signalled: number[] = [];
    const service = new TaskCancellationService({ taskStore: store, runtimeRoot, terminate: (pid) => signalled.push(pid) });

    const result = await service.request({ taskId: task.id, nodeId: 'requirement-analysis', note: '需求暂停' });

    expect(result).toEqual({ taskId: task.id, nodeId: 'requirement-analysis', runId: 'run-1', status: 'signalled' });
    expect(signalled).toEqual([12345]);
    await expect(readFile(join(runtimeRoot, task.id, 'run-1', 'cancel-request.json'), 'utf8')).resolves.toContain('需求暂停');
  });
});
