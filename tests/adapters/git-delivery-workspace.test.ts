import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { GitDeliveryWorkspaceManager } from '../../src/adapters/git-delivery-workspace.js';
import { runGitProcess } from '../../src/adapters/git-process.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTempDirectory));
});

describe('GitDeliveryWorkspaceManager', () => {
  it('does not leak stdin EPIPE when Git exits before reading a large input', async () => {
    await expect(runGitProcess(process.cwd(), ['--version'], 'x'.repeat(16 * 1024 * 1024))).resolves.toMatchObject({
      stderr: '',
    });
  });

  it('keeps business changes isolated until publish and excludes .aiw facts from the patch', async () => {
    const fixture = await createRepository();
    const manager = new GitDeliveryWorkspaceManager();
    const workspace = await manager.prepare({
      projectRoot: fixture.projectRoot,
      runtimeRoot: fixture.runtimeRoot,
      taskId: 'task-1',
      nodeId: 'delivery-list',
      runId: 'run-1',
    });

    await expect(readFile(join(workspace.projectRoot, 'node_modules', 'fixture.txt'), 'utf8')).resolves.toBe('dependency fixture\n');

    await writeFile(join(workspace.projectRoot, 'src', 'feature.ts'), 'export const value = 2;\n', 'utf8');
    await writeFile(join(workspace.projectRoot, 'src', 'created.ts'), 'export const created = true;\n', 'utf8');
    await mkdir(join(workspace.projectRoot, '.aiw', 'tasks', 'task-1'), { recursive: true });
    await writeFile(join(workspace.projectRoot, '.aiw', 'tasks', 'task-1', 'agent-output.md'), 'isolated only\n', 'utf8');

    await expect(readFile(join(fixture.projectRoot, 'src', 'feature.ts'), 'utf8')).resolves.toBe('export const value = 1;\n');
    await expect(readFile(join(fixture.projectRoot, 'src', 'created.ts'), 'utf8')).rejects.toThrow();

    const published = await workspace.publish();

    expect(published).toMatchObject({ published: true, changedPaths: ['src/created.ts', 'src/feature.ts'] });
    expect(published.patch).not.toContain('.aiw/');
    await expect(readFile(join(fixture.projectRoot, 'src', 'feature.ts'), 'utf8')).resolves.toBe('export const value = 2;\n');
    await expect(readFile(join(fixture.projectRoot, 'src', 'created.ts'), 'utf8')).resolves.toBe('export const created = true;\n');
    await expect(readFile(join(fixture.projectRoot, '.aiw', 'tasks', 'task-1', 'agent-output.md'), 'utf8')).rejects.toThrow();

    await workspace.dispose();
    await expect(readFile(join(workspace.projectRoot, 'src', 'feature.ts'), 'utf8')).rejects.toThrow();
  });

  it('discards failed workspace changes without touching the source repository', async () => {
    const fixture = await createRepository();
    const workspace = await new GitDeliveryWorkspaceManager().prepare({
      projectRoot: fixture.projectRoot,
      runtimeRoot: fixture.runtimeRoot,
      taskId: 'task-1',
      nodeId: 'delivery-list',
      runId: 'run-2',
    });
    await writeFile(join(workspace.projectRoot, 'src', 'feature.ts'), 'export const value = 9;\n', 'utf8');

    await workspace.dispose();

    await expect(readFile(join(fixture.projectRoot, 'src', 'feature.ts'), 'utf8')).resolves.toBe('export const value = 1;\n');
  });

  it('rolls a published business patch back when final task publication fails', async () => {
    const fixture = await createRepository();
    const workspace = await new GitDeliveryWorkspaceManager().prepare({
      projectRoot: fixture.projectRoot,
      runtimeRoot: fixture.runtimeRoot,
      taskId: 'task-1',
      nodeId: 'delivery-list',
      runId: 'run-rollback',
    });
    await writeFile(join(workspace.projectRoot, 'src', 'feature.ts'), 'export const value = 8;\n', 'utf8');

    await workspace.publish();
    await expect(readFile(join(fixture.projectRoot, 'src', 'feature.ts'), 'utf8')).resolves.toBe('export const value = 8;\n');

    await workspace.rollback();
    await expect(readFile(join(fixture.projectRoot, 'src', 'feature.ts'), 'utf8')).resolves.toBe('export const value = 1;\n');
    await workspace.dispose();
  });

  it('refuses to publish after the source HEAD changes', async () => {
    const fixture = await createRepository();
    const workspace = await new GitDeliveryWorkspaceManager().prepare({
      projectRoot: fixture.projectRoot,
      runtimeRoot: fixture.runtimeRoot,
      taskId: 'task-1',
      nodeId: 'delivery-list',
      runId: 'run-3',
    });
    await writeFile(join(workspace.projectRoot, 'src', 'feature.ts'), 'export const value = 3;\n', 'utf8');
    await writeFile(join(fixture.projectRoot, 'README.md'), '# changed while running\n', 'utf8');
    await git(fixture.projectRoot, ['add', 'README.md']);
    await git(fixture.projectRoot, ['commit', '-m', 'concurrent change']);

    await expect(workspace.publish()).rejects.toThrow('源仓库 HEAD 已变化');
    await expect(readFile(join(fixture.projectRoot, 'src', 'feature.ts'), 'utf8')).resolves.toBe('export const value = 1;\n');
    await workspace.dispose();
  });

  it('refuses to publish over uncommitted source business changes', async () => {
    const fixture = await createRepository();
    const workspace = await new GitDeliveryWorkspaceManager().prepare({
      projectRoot: fixture.projectRoot,
      runtimeRoot: fixture.runtimeRoot,
      taskId: 'task-1',
      nodeId: 'delivery-list',
      runId: 'run-4',
    });
    await writeFile(join(workspace.projectRoot, 'src', 'feature.ts'), 'export const value = 4;\n', 'utf8');
    await writeFile(join(fixture.projectRoot, 'README.md'), '# local business change\n', 'utf8');

    await expect(workspace.publish()).rejects.toThrow('源业务工作区已变化');
    await expect(readFile(join(fixture.projectRoot, 'src', 'feature.ts'), 'utf8')).resolves.toBe('export const value = 1;\n');
    await workspace.dispose();
  });
});

async function createRepository(): Promise<{ projectRoot: string; runtimeRoot: string }> {
  const root = await createTempDirectory('aiw-delivery-workspace-');
  directories.push(root);
  const projectRoot = join(root, 'project');
  const runtimeRoot = join(root, 'runtime');
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await mkdir(join(projectRoot, 'node_modules'), { recursive: true });
  await writeFile(join(projectRoot, 'node_modules', 'fixture.txt'), 'dependency fixture\n', 'utf8');
  await writeFile(join(projectRoot, '.gitignore'), 'node_modules/\n', 'utf8');
  await writeFile(join(projectRoot, 'src', 'feature.ts'), 'export const value = 1;\n', 'utf8');
  await writeFile(join(projectRoot, 'README.md'), '# fixture\n', 'utf8');
  await git(projectRoot, ['init']);
  await git(projectRoot, ['config', 'user.email', 'aiw@example.test']);
  await git(projectRoot, ['config', 'user.name', 'AIW Test']);
  await git(projectRoot, ['add', '.']);
  await git(projectRoot, ['commit', '-m', 'initial']);
  return { projectRoot, runtimeRoot };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args]);
}
