import { spawn } from 'node:child_process';

import { ExecutableNotFoundError, type ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from '../ports/process-runner.js';

export class NodeProcessRunner implements ProcessRunner {
  async run(input: ProcessRunInput): Promise<ProcessRunOutput> {
    return new Promise<ProcessRunOutput>((resolve, reject) => {
      const child = spawn(input.command, input.args, { cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'], ...(input.env === undefined ? {} : { env: input.env }) });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      }, input.timeoutMs);
      const clearTimers = () => {
        clearTimeout(timeoutTimer);
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
        }
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.stdin.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'EPIPE') return;
        clearTimers();
        reject(error);
      });
      child.once('error', (error) => {
        clearTimers();
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new ExecutableNotFoundError(input.command));
          return;
        }
        reject(error);
      });
      child.once('close', (exitCode, signal) => {
        clearTimers();
        resolve({ exitCode, signal, stdout, stderr, timedOut });
      });
      void (async () => {
        try {
          if (child.pid === undefined) throw new Error('无法获取 Codex 进程 ID');
          await input.onStarted?.(child.pid);
          child.stdin.end(input.stdin);
        } catch (error) {
          clearTimers();
          child.kill('SIGTERM');
          reject(error);
        }
      })();
    });
  }
}
