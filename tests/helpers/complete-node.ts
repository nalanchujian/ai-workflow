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
      : nodeId === 'plan' && path === 'artifacts/implementation-context.md'
        ? '# 实施上下文\n\n## 目标\n\n完成退款功能的最小实现。\n'
        : nodeId === 'plan' && path === 'artifacts/work-breakdown.yaml'
          ? 'schemaVersion: aiw.work-breakdown/v1\nunits:\n  - id: main\n    title: 完成退款功能\n    goal: 完成退款功能的最小实现\n    allowedPaths:\n      - src/**\n    acceptanceRefs: [AC-01]\n    steps: [实现退款流程]\n    verification: [pnpm test]\n'
      : nodeId === 'test'
        ? '# 测试报告\n\n## 测试命令\n\n`pnpm test`\n\n## 测试结果\n\n通过。\n'
        : `# ${nodeId}\n\n## 结论\n\n已完成当前节点并保留可追溯结果。\n`;
    await writeFile(destination, content, 'utf8');
  }
}
