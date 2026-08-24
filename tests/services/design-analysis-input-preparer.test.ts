import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DesignAnalysisInputPreparer } from '../../src/services/design-analysis-input-preparer.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

describe('DesignAnalysisInputPreparer', () => {
  it('captures the registered Figma root into stable task facts', async () => {
    const root = await createTempDirectory('aiw-design-input-');
    directories.push(root);
    const store = new TaskStore(root);
    const task = createSevenPhaseTask();
    task.designInput = { provider: 'figma', url: 'https://www.figma.com/design/file-key/File?node-id=1-2', fileKey: 'file-key', nodeId: '1:2' };
    await store.create(task);
    const preparer = new DesignAnalysisInputPreparer({
      taskStore: store,
      connector: {
        supports: () => true,
        async captureRoot() { return { fileKey: 'file-key', nodeId: '1:2', metadata: '<frame name="Overview" />', screenshot: Buffer.from('png'), capturedAt: '2026-08-24T00:00:00.000Z' }; },
        async captureNode() { throw new Error('not used'); },
      },
    });

    await preparer.prepare(task);

    await expect(readFile(join(store.taskDirectory(task.id), 'sources/design/current/metadata.txt'), 'utf8')).resolves.toContain('Overview');
    await expect(readFile(join(store.taskDirectory(task.id), 'sources/design/current/overview.png'))).resolves.toEqual(Buffer.from('png'));
    await expect(readFile(join(store.taskDirectory(task.id), 'sources/design/current/meta.json'), 'utf8')).resolves.toContain('2026-08-24T00:00:00.000Z');
  });

  it('rejects design execution when the task has no registered design input', async () => {
    const root = await createTempDirectory('aiw-design-input-');
    directories.push(root);
    const preparer = new DesignAnalysisInputPreparer({ taskStore: new TaskStore(root), connector: {} as never });
    await expect(preparer.prepare(createSevenPhaseTask())).rejects.toThrow('任务没有登记 Figma 设计稿');
  });
});
