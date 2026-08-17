import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/run-cli.js';

describe('aiw CLI help', () => {
  it('prints the top-level command groups for --help', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('skills');
    expect(result.stdout).toContain('task');
    expect(result.stdout).toContain('history');
    expect(result.stdout).not.toMatch(/^ {2}run\s+查看和清理本机运行记录/m);
  });

  it('separates first-time setup, daily workflow, and advanced operations in help', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('首次使用：');
    expect(result.stdout).toContain('aiw init → aiw doctor');
    expect(result.stdout).toContain('日常使用：');
    expect(result.stdout).toContain('aiw task init → aiw task run');
    expect(result.stdout).toContain('AI 提出疑问时使用 aiw task review');
    expect(result.stdout).not.toContain('AI 提出疑问时使用 aiw task decision');
    expect(result.stdout).toContain('高级与例外场景：团队技能管理、运行记录清理、外部等待解除、风险关闭和任务取消。');
    expect(result.stdout).toContain('aiw history --help');
    expect(result.stdout).toContain('高级：管理团队技能和工作流模板');
  });

});
