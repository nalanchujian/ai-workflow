import { CommanderError } from 'commander';

import { createProgram } from '../../src/cli/create-program.js';

export interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export async function runCli(args: string[]): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const program = createProgram({ version: '0.0.0-test' });

  program
    .exitOverride()
    .configureOutput({
      writeOut: (chunk) => {
        stdout += chunk;
      },
      writeErr: (chunk) => {
        stderr += chunk;
      },
    });

  try {
    await program.parseAsync(['node', 'aiw', ...args]);
    return { exitCode: 0, stderr, stdout };
  } catch (error) {
    if (error instanceof CommanderError) {
      return { exitCode: error.exitCode, stderr, stdout };
    }

    throw error;
  }
}
