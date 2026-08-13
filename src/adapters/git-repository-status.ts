import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { RepositoryStatus } from '../ports/repository-status.js';

const execFileAsync = promisify(execFile);

export class GitRepositoryStatus implements RepositoryStatus {
  async uncommittedPaths(input: { projectRoot: string; paths: string[] }): Promise<string[]> {
    const { stdout } = await execFileAsync('git', ['-C', input.projectRoot, 'status', '--porcelain=v1', '--untracked-files=all', '--', ...input.paths]);
    const changed = stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
    return input.paths.filter((path) => changed.some((candidate) => candidate === path || candidate.startsWith(`${path}/`) || path.startsWith(`${candidate}/`)));
  }

  async authorName(): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['config', 'user.name']);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }
}
