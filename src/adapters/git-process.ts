import { spawn } from 'node:child_process';

export class GitProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitProcessError';
  }
}

export async function runGitProcess(cwd: string, args: string[], stdin = ''): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hasInput = stdin.length > 0;
    const child = spawn('git', ['-C', cwd, ...args], { stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (child.stdout === null || child.stderr === null) {
      child.kill();
      rejectPromise(new GitProcessError('Git 子进程输出流不可用'));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new GitProcessError(`Git 命令失败：git ${args.join(' ')}${stderr.trim() === '' ? '' : `（${stderr.trim()}）`}`));
    });
    if (hasInput && child.stdin !== null) {
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') rejectPromise(error);
      });
      child.stdin.end(stdin);
    }
  });
}
