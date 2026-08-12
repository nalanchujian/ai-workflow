#!/usr/bin/env node

import { CommanderError } from 'commander';

import { createProgram } from './cli/create-program.js';

async function main(): Promise<void> {
  const program = createProgram({ version: '0.1.0' });

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
