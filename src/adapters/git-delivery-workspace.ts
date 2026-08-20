import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import type {
  DeliveryWorkspace,
  DeliveryWorkspaceManager,
  DeliveryWorkspacePublishResult,
} from '../ports/delivery-workspace.js';

const safeSegment = /^[A-Za-z0-9._-]+$/;
const businessPathspec = [
  '.',
  ':(exclude).aiw',
  ':(exclude).aiw/**',
  ':(exclude)node_modules',
];

export class DeliveryWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryWorkspaceError';
  }
}

export class GitDeliveryWorkspaceManager implements DeliveryWorkspaceManager {
  async prepare(input: {
    projectRoot: string;
    runtimeRoot: string;
    taskId: string;
    nodeId: string;
    runId: string;
  }): Promise<DeliveryWorkspace> {
    for (const [label, value] of [['任务 ID', input.taskId], ['节点 ID', input.nodeId], ['运行 ID', input.runId]] as const) {
      if (!safeSegment.test(value)) throw new DeliveryWorkspaceError(`${label} 不能用于创建隔离执行区`);
    }
    const projectRoot = resolve(input.projectRoot);
    const runtimeRoot = resolve(input.runtimeRoot);
    const runDirectory = resolve(runtimeRoot, input.taskId, input.runId);
    const workspaceRoot = join(runDirectory, 'workspace');
    if (relative(runtimeRoot, workspaceRoot).startsWith('..')) {
      throw new DeliveryWorkspaceError('隔离执行区越出本机运行目录');
    }
    const sourceHead = (await git(projectRoot, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
    if (sourceHead.length === 0) throw new DeliveryWorkspaceError('无法读取源仓库 HEAD');
    await git(projectRoot, ['worktree', 'prune']);
    await mkdir(dirname(workspaceRoot), { recursive: true });
    await git(projectRoot, ['worktree', 'add', '--detach', workspaceRoot, sourceHead]);
    await linkNodeModules(projectRoot, workspaceRoot);
    return new GitDeliveryWorkspace(projectRoot, workspaceRoot, sourceHead);
  }
}

class GitDeliveryWorkspace implements DeliveryWorkspace {
  readonly projectRoot: string;
  private published?: DeliveryWorkspacePublishResult;
  private rolledBack = false;
  private disposed = false;

  constructor(
    private readonly sourceProjectRoot: string,
    workspaceRoot: string,
    readonly sourceHead: string,
  ) {
    this.projectRoot = workspaceRoot;
  }

  async publish(): Promise<DeliveryWorkspacePublishResult> {
    if (this.disposed) throw new DeliveryWorkspaceError('隔离执行区已经清理');
    if (this.published !== undefined) return this.published;
    const workspaceHead = (await git(this.projectRoot, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
    if (workspaceHead !== this.sourceHead) {
      throw new DeliveryWorkspaceError('隔离执行区 Git 历史已变化，不能发布业务改动');
    }
    await git(this.projectRoot, ['add', '-A', '--', ...businessPathspec]);
    const [patchResult, pathsResult] = await Promise.all([
      git(this.projectRoot, ['diff', '--cached', '--binary', '--full-index', 'HEAD']),
      git(this.projectRoot, ['diff', '--cached', '--name-only', '-z', 'HEAD']),
    ]);
    const patch = patchResult.stdout;
    const changedPaths = pathsResult.stdout.split('\0').filter(Boolean).sort();
    const result: DeliveryWorkspacePublishResult = {
      published: patch.length > 0,
      patch,
      patchSha256: createHash('sha256').update(patch).digest('hex'),
      changedPaths,
    };
    if (patch.length === 0) {
      this.published = result;
      return result;
    }
    const sourceHead = (await git(this.sourceProjectRoot, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
    if (sourceHead !== this.sourceHead) {
      throw new DeliveryWorkspaceError('源仓库 HEAD 已变化，不能发布隔离执行结果');
    }
    const sourceChanges = await changedPathsIn(this.sourceProjectRoot);
    const businessChanges = sourceChanges.filter((path) => path !== '.aiw' && !path.startsWith('.aiw/'));
    if (businessChanges.length > 0) {
      throw new DeliveryWorkspaceError(`源业务工作区已变化，不能发布隔离执行结果：${businessChanges.join(', ')}`);
    }
    await git(this.sourceProjectRoot, ['apply', '--check', '--binary', '-'], patch);
    await git(this.sourceProjectRoot, ['apply', '--binary', '-'], patch);
    this.published = result;
    return result;
  }

  async rollback(): Promise<void> {
    if (this.disposed) throw new DeliveryWorkspaceError('隔离执行区已经清理');
    if (this.rolledBack || this.published?.published !== true) return;
    const sourceHead = (await git(this.sourceProjectRoot, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
    if (sourceHead !== this.sourceHead) {
      throw new DeliveryWorkspaceError('源仓库 HEAD 已变化，无法安全回滚隔离执行结果');
    }
    await git(this.sourceProjectRoot, ['apply', '--reverse', '--check', '--binary', '-'], this.published.patch);
    await git(this.sourceProjectRoot, ['apply', '--reverse', '--binary', '-'], this.published.patch);
    this.rolledBack = true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await git(this.sourceProjectRoot, ['worktree', 'remove', '--force', this.projectRoot]);
    } catch {
      await rm(this.projectRoot, { recursive: true, force: true });
      await git(this.sourceProjectRoot, ['worktree', 'prune']).catch(() => undefined);
    }
  }
}

async function linkNodeModules(sourceRoot: string, workspaceRoot: string): Promise<void> {
  const source = join(sourceRoot, 'node_modules');
  try {
    await access(source);
    await symlink(source, join(workspaceRoot, 'node_modules'), 'dir');
  } catch {
    // A project without installed dependencies remains valid. Its configured
    // health check or test command will report the missing runtime explicitly.
  }
}

async function changedPathsIn(projectRoot: string): Promise<string[]> {
  const output = (await git(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all', '-z'])).stdout.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < output.length; index += 1) {
    const entry = output[index]!;
    if (entry.length < 4 || entry[2] !== ' ') continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if ((status.includes('R') || status.includes('C')) && output[index + 1] !== undefined) {
      paths.push(output[index + 1]!);
      index += 1;
    }
  }
  return [...new Set(paths.filter(Boolean))].sort();
}

async function git(cwd: string, args: string[], stdin = ''): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new DeliveryWorkspaceError(`Git 命令失败：git ${args.join(' ')}${stderr.trim() === '' ? '' : `（${stderr.trim()}）`}`));
    });
    child.stdin.end(stdin);
  });
}
