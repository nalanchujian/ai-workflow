import { spawn } from 'node:child_process';

import { ExecutableNotFoundError, type ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from '../ports/process-runner.js';

export class NodeProcessRunner implements ProcessRunner {
  async run(input: ProcessRunInput): Promise<ProcessRunOutput> {
    return new Promise<ProcessRunOutput>((resolve, reject) => {
      const child = spawn(input.command, input.args, { cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new ExecutableNotFoundError(input.command));
          return;
        }
        reject(error);
      });
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
      child.stdin.end(input.stdin);
    });
  }
}
