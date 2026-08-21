import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('TaskStore', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(removeTempDirectory));
  });

  it('persists and reloads a validated task from the shared task directory', async () => {
    const projectRoot = await createTempDirectory('aiw-task-store-');
    directories.push(projectRoot);
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();

    await store.create(task);
    const loaded = await store.load(task.id);

    expect(loaded).toMatchObject({ id: 'refund-123', schemaVersion: 'aiw.task/v3' });
    expect(loaded.nodes.clarify.status).toBe('ready');
  });

  it('removes only requested facts inside the task directory', async () => {
    const projectRoot = await createTempDirectory('aiw-task-store-');
    directories.push(projectRoot);
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();
    await store.create(task);
    await store.createFact(task.id, 'artifacts/brief.md', '# Brief\n');
    await store.createFact(task.id, 'notes/clarify.txt', 'note\n');

    await store.removeFacts(task.id, ['artifacts/brief.md', 'notes/clarify.txt']);

    await expect(readFile(join(store.taskDirectory(task.id), 'artifacts', 'brief.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(store.taskDirectory(task.id), 'notes', 'clarify.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.load(task.id)).resolves.toMatchObject({ id: task.id });
  });

  it('increments stateVersion and rejects a stale task update', async () => {
    const projectRoot = await createTempDirectory('aiw-task-store-');
    directories.push(projectRoot);
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();
    await store.create(task);
    const first = await store.load(task.id);
    const stale = await store.load(task.id);
    first.title = '第一个写入者';
    stale.title = '陈旧写入者';

    const updated = await store.update(first);

    expect(updated.stateVersion).toBe(1);
    await expect(store.update(stale)).rejects.toThrow('任务状态已变化');
    await expect(store.load(task.id)).resolves.toMatchObject({ title: '第一个写入者', stateVersion: 1 });
  });
});
