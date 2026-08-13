#!/usr/bin/env node

import { CommanderError } from 'commander';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createProgram } from './cli/create-program.js';
import { createProductionCliRuntime } from './cli/create-runtime.js';
import { packageVersion } from './cli/package-version.js';

async function main(): Promise<void> {
  const homeDirectory = process.env.AIW_HOME ?? join(homedir(), '.aiw');
  const program = createProgram({ version: packageVersion, runtime: createProductionCliRuntime({ homeDirectory }) });

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }

    const message = error instanceof Error ? error.message : '未知错误';
    process.stderr.write(`aiw: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
