import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TaskStore } from '../../src/services/task-store.js';

export async function completeNode(projectRoot: string, taskId: string, nodeId: string): Promise<void> {
  const store = new TaskStore(projectRoot);
  const task = await store.load(taskId);
  const node = task.nodes[nodeId];
  if (node === undefined) {
    throw new Error(`未知节点：${nodeId}`);
  }
  for (const path of node.outputs) {
    const destination = join(store.taskDirectory(taskId), path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, `# ${nodeId}\n`, 'utf8');
  }
}
