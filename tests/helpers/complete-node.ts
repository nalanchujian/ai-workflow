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
    const content = nodeId === 'plan' && path === 'artifacts/implementation-plan.md'
      ? '# plan\n\n```yaml\nallowedPaths:\n  - src/**\n```\n'
      : nodeId === 'test'
        ? '# 测试报告\n\n## 测试命令\n\n`pnpm test`\n\n## 测试结果\n\n通过。\n'
        : `# ${nodeId}\n\n## 结论\n\n已完成当前节点并保留可追溯结果。\n`;
    await writeFile(destination, content, 'utf8');
  }
}
