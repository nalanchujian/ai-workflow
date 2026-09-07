import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = join(fileURLToPath(new URL('../..', import.meta.url)));
const cleanScript = join(repositoryRoot, 'scripts', 'assert-release-clean.mjs');
const readyScript = join(repositoryRoot, 'scripts', 'assert-release-ready.mjs');

describe('release worktree gates', () => {
  const directories: string[] = [];

  afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))));

  it('rejects a release before versioning when any source change is uncommitted', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'src.ts'), 'export const changed = true;\n');

    await expect(execFileAsync(process.execPath, [cleanScript], { cwd: directory }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('发布前工作区必须干净') });
  });

  it('allows publishing only when package.json is the sole versioning change', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'src', 'services', 'default-workflow.ts'), "export const officialDefaultWorkflow = { defaultSkillSource: { ref: 'v1.0.1' } };\n");
    await git(directory, ['add', 'src/services/default-workflow.ts']);
    await git(directory, ['commit', '-m', 'sync default skills']);
    await writeFile(join(directory, 'package.json'), '{"name":"example","version":"1.0.1"}\n');

    await expect(execFileAsync(process.execPath, [readyScript], { cwd: directory })).resolves.toMatchObject({ stderr: '' });
    await writeFile(join(directory, 'src.ts'), 'export const changed = true;\n');
    await expect(execFileAsync(process.execPath, [readyScript], { cwd: directory }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('仅允许 package.json 作为发布版本变更') });
  });

  it('rejects publishing when the default skills tag does not match the AIW version', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'package.json'), '{"name":"example","version":"1.0.1"}\n');

    await expect(execFileAsync(process.execPath, [readyScript], { cwd: directory }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('默认技能包标签 v1.0.0 不一致') });
  });

  async function repository(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'aiw-release-gate-'));
    directories.push(directory);
    await writeFile(join(directory, 'package.json'), '{"name":"example","version":"1.0.0"}\n');
    await writeFile(join(directory, 'src.ts'), 'export const initial = true;\n');
    await mkdir(join(directory, 'src', 'services'), { recursive: true });
    await writeFile(join(directory, 'src', 'services', 'default-workflow.ts'), "export const officialDefaultWorkflow = { defaultSkillSource: { ref: 'v1.0.0' } };\n");
    await git(directory, ['init']);
    await git(directory, ['config', 'user.email', 'aiw@example.com']);
    await git(directory, ['config', 'user.name', 'AIW Test']);
    await git(directory, ['add', '.']);
    await git(directory, ['commit', '-m', 'initial']);
    return directory;
  }
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}
