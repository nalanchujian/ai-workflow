import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { TerminalProgressReporter } from '../../src/cli/progress-reporter.js';

describe('TerminalProgressReporter', () => {
  it('reports start and completion for an interactive command', () => {
    let output = '';
    const reporter = new TerminalProgressReporter({
      stderr: { isTTY: true, write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
      spinnerIntervalMs: 60_000,
    });
    const command = new Command();

    const progress = reporter.start(command, '正在读取需求');
    progress.succeed('需求已固化');

    expect(output).toContain('◐ 正在读取需求');
    expect(output).toContain('✓ 需求已固化');
  });

  it('keeps JSON command output free from progress text', () => {
    let output = '';
    const reporter = new TerminalProgressReporter({
      stderr: { isTTY: true, write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });
    const command = new Command().option('--json');
    command.parse(['node', 'aiw', '--json']);

    reporter.start(command, '正在读取需求').succeed('需求已固化');

    expect(output).toBe('');
  });
});
