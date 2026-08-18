import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { GitRepositoryStatus } from '../../src/adapters/git-repository-status.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTempDirectory));
});

describe('GitRepositoryStatus project admission', () => {
  it('rejects a directory that is not a Git worktree', async () => {
    const projectRoot = await temporaryDirectory();

    await expect(new GitRepositoryStatus().assertProjectReady(projectRoot)).rejects.toThrow('不是 Git 工作树');
  });

  it('rejects a Git worktree that ignores .aiw', async () => {
    const projectRoot = await temporaryDirectory();
    await execFileAsync('git', ['init', '--quiet', projectRoot]);
    await writeFile(join(projectRoot, '.gitignore'), '.aiw/\n', 'utf8');
    await mkdir(join(projectRoot, '.aiw'), { recursive: true });

    await expect(new GitRepositoryStatus().assertProjectReady(projectRoot)).rejects.toThrow('.aiw/ 被 Git 忽略');
  });

  it('reports both paths when a tracked task fact is renamed', async () => {
    const projectRoot = await temporaryDirectory();
    await execFileAsync('git', ['init', '--quiet', projectRoot]);
    await execFileAsync('git', ['-C', projectRoot, 'config', 'user.name', 'AIW Test']);
    await execFileAsync('git', ['-C', projectRoot, 'config', 'user.email', 'aiw@example.test']);
    await mkdir(join(projectRoot, '.aiw', 'tasks', 'refund-123', 'artifacts'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(join(projectRoot, '.aiw', 'tasks', 'refund-123', 'artifacts', 'brief.md'), '# 需求摘要\n', 'utf8');
    await execFileAsync('git', ['-C', projectRoot, 'add', '.']);
    await execFileAsync('git', ['-C', projectRoot, 'commit', '--quiet', '-m', 'initial task fact']);
    await execFileAsync('git', ['-C', projectRoot, 'mv', '.aiw/tasks/refund-123/artifacts/brief.md', 'src/brief.md']);

    await expect(new GitRepositoryStatus().changedPaths({ projectRoot })).resolves.toEqual([
      '.aiw/tasks/refund-123/artifacts/brief.md',
      'src/brief.md',
    ]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await createTempDirectory('aiw-repository-status-');
  directories.push(directory);
  return directory;
}
