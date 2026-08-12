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

    expect(loaded).toMatchObject({ id: 'refund-123', schemaVersion: 'aiw.task/v1' });
    expect(loaded.nodes.clarify.status).toBe('ready');
  });
});
