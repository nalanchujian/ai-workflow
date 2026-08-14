import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TaskStore } from '../../src/services/task-store.js';
import { handoffPath, outputPathsForNextRun } from '../../src/domain/handoff.js';

export async function completeNode(projectRoot: string, taskId: string, nodeId: string): Promise<void> {
  const store = new TaskStore(projectRoot);
  const task = await store.load(taskId);
  const node = task.nodes[nodeId];
  if (node === undefined) {
    throw new Error(`未知节点：${nodeId}`);
  }
  for (const path of outputPathsForNextRun(nodeId, node)) {
    const destination = join(store.taskDirectory(taskId), path);
    await mkdir(join(destination, '..'), { recursive: true });
    const content = path === handoffPath(nodeId, node.revision + 1)
      ? `schemaVersion: aiw.handoff/v1\ntaskId: ${taskId}\nnodeId: ${nodeId}\nphase: ${node.phase}\nrevision: ${node.revision + 1}\nsummary: 已完成${node.title}并记录可追溯交接结论。\nfacts:\n  - id: FACT-01\n    statement: 当前节点已生成声明的工作产物。\n    evidence:\n      - path: ${node.outputs[0]}\ndecisions: []\nacceptance: []\nchanges: []\nverification: []\nopenRisks: []\n`
      : nodeId === 'plan' && path === 'artifacts/implementation-plan.md'
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
