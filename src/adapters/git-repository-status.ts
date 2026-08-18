import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { RepositoryStatus, WorkingTreeStatus } from '../ports/repository-status.js';
import { ProjectRepositoryError, type ProjectRepository } from '../ports/project-repository.js';

const execFileAsync = promisify(execFile);

export class GitRepositoryStatus implements RepositoryStatus, WorkingTreeStatus, ProjectRepository {
  async assertProjectReady(projectRoot: string): Promise<void> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree']);
      if (stdout.trim() !== 'true') {
        throw new Error('not worktree');
      }
    } catch {
      throw new ProjectRepositoryError('PROJECT_NOT_GIT', '项目不是 Git 工作树');
    }
    try {
      await execFileAsync('git', ['-C', projectRoot, 'check-ignore', '--quiet', '--', '.aiw']);
      throw new ProjectRepositoryError('AIW_IGNORED', '.aiw/ 被 Git 忽略');
    } catch (error) {
      if (error instanceof ProjectRepositoryError) {
        throw error;
      }
      if (isExitCode(error, 1)) {
        return;
      }
      throw new ProjectRepositoryError('PROJECT_NOT_GIT', '无法检查项目 Git 状态');
    }
  }

  async uncommittedPaths(input: { projectRoot: string; paths: string[] }): Promise<string[]> {
    const { stdout } = await execFileAsync('git', ['-C', input.projectRoot, 'status', '--porcelain=v1', '--untracked-files=all', '--', ...input.paths]);
    const changed = stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
    return input.paths.filter((path) => changed.some((candidate) => candidate === path || candidate.startsWith(`${path}/`) || path.startsWith(`${candidate}/`)));
  }

  async changedPaths(input: { projectRoot: string }): Promise<string[]> {
    const { stdout } = await execFileAsync('git', ['-C', input.projectRoot, 'status', '--porcelain=v1', '--untracked-files=all', '-z']);
    const entries = stdout.split('\0');
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.length < 4 || entry[2] !== ' ') continue;
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      if (path.length > 0) paths.push(path);
      if ((status.includes('R') || status.includes('C')) && entries[index + 1] !== undefined) {
        const originalPath = entries[index + 1]!;
        if (originalPath.length > 0) paths.push(originalPath);
        index += 1;
      }
    }
    return [...new Set(paths)].sort();
  }

  async untrackedPaths(input: { projectRoot: string }): Promise<string[]> {
    const { stdout } = await execFileAsync('git', ['-C', input.projectRoot, 'ls-files', '--others', '--exclude-standard', '-z']);
    return stdout.split('\0').filter(Boolean).sort();
  }

  async diff(input: { projectRoot: string }): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', input.projectRoot, 'diff', '--no-ext-diff', '--binary', 'HEAD']);
    return stdout;
  }

  async revision(input: { projectRoot: string }): Promise<{ head?: string; branch?: string }> {
    const head = await gitValue(input.projectRoot, ['rev-parse', '--verify', 'HEAD']);
    const branch = await gitValue(input.projectRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return { ...(head === undefined ? {} : { head }), ...(branch === undefined ? {} : { branch }) };
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

async function gitValue(projectRoot: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectRoot, ...args]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function isExitCode(error: unknown, code: number): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
