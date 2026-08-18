import { describe, expect, it } from 'vitest';

import { renderCliError } from '../../src/cli/error-guidance.js';

describe('CLI error guidance', () => {
  it('turns uncommitted task facts into a commit and retry checklist', () => {
    const output = renderCliError(
      new Error('任务事实尚未提交：.aiw/tasks/refund-123/task.yaml'),
      ['task', 'run', 'refund-123', 'plan'],
    );

    expect(output).toContain('aiw: 任务事实尚未提交：.aiw/tasks/refund-123/task.yaml');
    expect(output).toContain('1. git add .aiw');
    expect(output).toContain('2. git commit -m "chore(aiw): record task facts"');
    expect(output).toContain('3. aiw task run refund-123 plan');
  });

  it('guides users to inspect a dirty business worktree before retrying', () => {
    const output = renderCliError(
      new Error('业务仓库存在未提交变更，无法建立可信基线：src/refund.ts'),
      ['task', 'run', 'refund-123', 'verify'],
    );

    expect(output).toContain('1. git status --short');
    expect(output).toContain('2. 将已有业务改动提交、暂存到其他工作区，或明确处理后再继续。');
    expect(output).toContain('3. aiw task run refund-123 verify');
  });

  it('guides users to refresh a tampered source snapshot before retrying', () => {
    const output = renderCliError(
      new Error('来源「requirements」的快照内容哈希与 task.yaml 不一致；请通过 aiw task source refresh refund-123 requirements 重新固化需求来源后再运行。'),
      ['task', 'run', 'refund-123', 'solution'],
    );

    expect(output).toContain('不要手动编辑 .aiw/tasks/ 下的 snapshot.md 或 meta.json。');
    expect(output).toContain('执行错误信息中给出的 task source refresh 命令，重新读取并固化需求来源。');
    expect(output).toContain('3. aiw task run refund-123 solution');
  });
});
