import { CommanderError } from 'commander';

import { createProgram } from '../../src/cli/create-program.js';
import type { CliRuntime } from '../../src/cli/create-runtime.js';

export interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export async function runCli(args: string[], runtime?: CliRuntime): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const output = { write(chunk: string) { stdout += chunk; return true; } } as unknown as NodeJS.WriteStream;
  const program = createProgram({ version: '0.0.0-test', runtime, stdout: output });

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
