import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = join(fileURLToPath(new URL('../..', import.meta.url)));
const scriptPath = join(repositoryRoot, 'scripts', 'commit-published-package.mjs');

describe('commit-published-package', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  });

  it('commits only the published package manifest after its version changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiw-release-'));
    directories.push(directory);
    await writeFile(join(directory, 'package.json'), '{"name":"example","version":"1.0.0"}\n');
    await writeFile(join(directory, 'notes.md'), 'initial\n');
    await git(directory, ['init']);
    await git(directory, ['config', 'user.email', 'aiw@example.com']);
    await git(directory, ['config', 'user.name', 'AIW Test']);
    await git(directory, ['add', 'package.json', 'notes.md']);
    await git(directory, ['commit', '-m', 'initial']);

    await writeFile(join(directory, 'package.json'), '{"name":"example","version":"1.0.1"}\n');
    await writeFile(join(directory, 'notes.md'), 'unrelated\n');
    await git(directory, ['add', 'notes.md']);

    await execFileAsync(process.execPath, [scriptPath], { cwd: directory });

    await expect(git(directory, ['show', '--format=', '--name-only', 'HEAD'])).resolves.toBe('package.json\n');
    await expect(git(directory, ['log', '-1', '--format=%s'])).resolves.toBe('chore: release v1.0.1\n');
    await expect(readFile(join(directory, 'notes.md'), 'utf8')).resolves.toBe('unrelated\n');
    await expect(git(directory, ['status', '--short'])).resolves.toBe('M  notes.md\n');
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd });
  return result.stdout;
}
