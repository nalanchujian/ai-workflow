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
});

async function temporaryDirectory(): Promise<string> {
  const directory = await createTempDirectory('aiw-repository-status-');
  directories.push(directory);
  return directory;
}
