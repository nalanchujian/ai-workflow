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
  const outputPaths = outputPathsForNextRun(nodeId, node);
  const firstArtifact = outputPaths.find((path) => path.startsWith('artifacts/'));
  if (firstArtifact === undefined) {
    throw new Error(`节点 ${nodeId} 缺少声明产物`);
  }
  for (const path of outputPaths) {
    const destination = join(store.taskDirectory(taskId), path);
    await mkdir(join(destination, '..'), { recursive: true });
    const content = path === handoffPath(nodeId, node.revision + 1)
      ? `schemaVersion: aiw.handoff/v1\ntaskId: ${taskId}\nnodeId: ${nodeId}\nphase: ${node.phase}\nrevision: ${node.revision + 1}\nsummary: 已完成${node.title}并记录可追溯交接结论。\nfacts:\n  - id: FACT-01\n    statement: 当前节点已生成声明的工作产物。\n    evidence:\n      - path: ${firstArtifact}\ndecisions: []\nacceptance: []\nchanges: []\nverification: []\nopenRisks: []\n`
      : nodeId === 'plan' && path.endsWith('/implementation-plan.md')
      ? '# 实施计划\n\n## 实施单元\n\n- 完成退款功能。\n\n## 范围与边界\n\n- 复用现有退款流程，不新增依赖。\n\n## 验证方式\n\n- pnpm test\n'
      : nodeId === 'plan' && path.endsWith('/implementation-context.md')
        ? '# 实施上下文\n\n## 目标\n\n完成退款功能的最小实现。\n\n## 验收项\n\n- AC-01\n\n## 实施步骤\n\n1. 实现退款流程。\n\n## 验证\n\n- pnpm test\n'
      : nodeId === 'plan' && path.endsWith('/work-breakdown.yaml')
          ? 'schemaVersion: aiw.work-breakdown/v1\nunits:\n  - id: main\n    title: 完成退款功能\n    goal: 完成退款功能的最小实现\n    acceptanceRefs: [AC-01]\n    steps: [实现退款流程]\n    verification: [pnpm test]\nacceptanceCoverage:\n  - acceptanceId: AC-01\n    disposition: implement\n    workUnitIds: [main]\n'
      : nodeId === 'clarify' && path.endsWith('/decision-register.yaml')
        ? 'schemaVersion: aiw.decision-register/v1\nitems: []\n'
      : nodeId === 'clarify' && path.endsWith('/acceptance.yaml')
        ? 'schemaVersion: aiw.acceptance-catalog/v1\nitems:\n  - id: AC-01\n    title: 退款申请\n    description: 用户可以提交退款申请并查看处理结果。\n'
      : nodeId === 'clarify' && path.endsWith('/brief.md')
        ? '# 需求摘要\n\n## 目标与范围\n\n完成退款申请功能。\n\n## 来源依据\n\n- sources/requirements/r1/snapshot.md\n'
        : nodeId === 'clarify' && path.endsWith('/questions.md')
          ? '# 需求疑问\n\n## 开放问题\n\n无。\n\n## 影响\n\n当前可继续推进。\n'
          : nodeId === 'clarify' && path.endsWith('/acceptance.md')
            ? '# 验收标准\n\n## 验收项\n\n- AC-01：用户可以提交退款申请并查看处理结果。\n'
            : nodeId === 'solution'
              ? '# 技术方案\n\n## 方案结论\n\n沿用现有退款流程。\n\n## 架构与接口影响\n\n不新增依赖。\n\n## 风险与待决事项\n\n无。\n'
              : nodeId === 'implement'
                ? '# 实施报告\n\n## 实际变更\n\n完成退款功能。\n\n## 测试命令\n\n`pnpm test`\n\n## 测试结果\n\n通过。\n\n## 未完成事项与风险\n\n无。\n'
                : nodeId === 'verify'
                  ? '# 工程验证报告\n\n## 执行命令\n\n`pnpm test`\n\n## 验证结果\n\n通过。\n\n## 覆盖边界与风险\n\n无。\n'
      : nodeId === 'test'
        ? path.endsWith('/acceptance-results.yaml')
          ? 'schemaVersion: aiw.acceptance-results/v1\nitems:\n  - id: AC-01\n    status: passed\n    evidence:\n      - artifacts/test-report.md\n'
          : '# 测试报告\n\n## 测试命令\n\n`pnpm test`\n\n## 测试结果\n\n通过。\n\n## 逐项验收\n\nAC-01 通过。\n\n## 阻塞缺陷与风险\n\n无。\n\n## 建议的下一步\n\n提交验收结论。\n'
        : `# ${nodeId}\n\n## 结论\n\n已完成当前节点并保留可追溯结果。\n`;
    await writeFile(destination, content, 'utf8');
  }
}
