import { describe, expect, it } from 'vitest';

import { createProgram } from '../../src/cli/create-program.js';
import { runCli } from '../helpers/run-cli.js';

describe('aiw CLI help', () => {
  it('prints the top-level command groups for --help', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('task');
    expect(result.stdout).not.toMatch(/^ {2}skills\s+/m);
    expect(result.stdout).not.toMatch(/^ {2}history\s+/m);
    expect(result.stdout).not.toMatch(/^ {2}run\s+查看和清理本机运行记录/m);
  });

  it('separates first-time setup, daily workflow, and advanced operations in help', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('首次使用：');
    expect(result.stdout).toContain('aiw init → aiw doctor');
    expect(result.stdout).toContain('日常使用：');
    expect(result.stdout).toContain('aiw task init --source "<Lark 地址>"');
    expect(result.stdout).toContain('aiw task continue <task-id>');
    expect(result.stdout).toContain('日常推进只需重复执行 task continue');
    expect(result.stdout).not.toContain('AI 提出疑问时使用 aiw task decision');
    expect(result.stdout).toContain('高级与例外场景：');
    expect(result.stdout).toContain('aiw history --help');
    expect(result.stdout).toContain('高级：管理团队技能和工作流模板');
  });

  it('puts the daily task commands before advanced task operations', async () => {
    const task = createProgram({ version: '0.0.0-test' }).commands.find((command) => command.name() === 'task');
    let output = '';
    task?.configureOutput({ writeOut(chunk) { output += chunk; } });
    task?.outputHelp();

    expect(output).toContain('init');
    expect(output).toContain('continue');
    expect(output).toContain('status');
    expect(output).toContain('高级与例外命令：');
    expect(output).toContain('task run');
    expect(output.indexOf('continue')).toBeLessThan(output.indexOf('高级与例外命令：'));
  });

});
