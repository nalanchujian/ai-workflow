import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/run-cli.js';

describe('aiw CLI help', () => {
  it('prints the top-level command groups for --help', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('skills');
    expect(result.stdout).toContain('task');
  });

  it('highlights the daily workflow and separates advanced operations in help', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('日常使用：');
    expect(result.stdout).toContain('aiw init → aiw doctor → aiw task init');
    expect(result.stdout).toContain('高级与维护：技能升级、运行记录清理。');
  });

});
