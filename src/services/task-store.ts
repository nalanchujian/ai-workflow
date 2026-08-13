import { access, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parse, stringify } from 'yaml';

import { TaskSchema, type Task } from '../domain/task.js';

export class TaskStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskStoreError';
  }
}

export class TaskStore {
  constructor(private readonly projectRoot: string) {}

  projectDirectory(): string {
    return this.projectRoot;
  }

  taskDirectory(taskId: string): string {
    return join(this.projectRoot, '.aiw', 'tasks', taskId);
  }

  async create(task: Task): Promise<void> {
    const parsed = TaskSchema.parse(task);
    const directory = this.taskDirectory(parsed.id);
    try {
      await access(join(directory, 'task.yaml'));
      throw new TaskStoreError(`任务已存在：${parsed.id}`);
    } catch (error) {
      if (error instanceof TaskStoreError) {
        throw error;
      }
    }
    await mkdir(directory, { recursive: true });
    await this.writeTask(parsed);
  }

  async createFromStaging(task: Task, stagingDirectory: string): Promise<void> {
    const parsed = TaskSchema.parse(task);
    const directory = this.taskDirectory(parsed.id);
    try {
      await access(directory);
      throw new TaskStoreError(`任务已存在：${parsed.id}`);
    } catch (error) {
      if (error instanceof TaskStoreError) {
        throw error;
      }
    }
    await mkdir(dirname(directory), { recursive: true });
    await this.writeTaskAt(stagingDirectory, parsed);
    await rename(stagingDirectory, directory);
  }

  async load(taskId: string): Promise<Task> {
    const taskPath = join(this.taskDirectory(taskId), 'task.yaml');
    try {
      return TaskSchema.parse(parse(await readFile(taskPath, 'utf8')));
    } catch (error) {
      if (error instanceof TaskStoreError) {
        throw error;
      }
      throw new TaskStoreError(`无法读取任务：${taskId}`);
    }
  }

  async list(): Promise<Task[]> {
    const tasksDirectory = join(this.projectRoot, '.aiw', 'tasks');
    try {
      const entries = await readdir(tasksDirectory, { withFileTypes: true });
      return Promise.all(entries
        .filter((entry) => entry.isDirectory() && /^[a-z][a-z0-9-]{1,63}$/.test(entry.name))
        .map((entry) => this.load(entry.name)));
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw new TaskStoreError('无法读取任务列表');
    }
  }

  async update(task: Task): Promise<void> {
    const parsed = TaskSchema.parse(task);
    await this.writeTask(parsed);
  }

  async createFact(taskId: string, path: string, content: string): Promise<void> {
    const directory = this.taskDirectory(taskId);
    const absolutePath = resolve(directory, path);
    if (this.relativeTaskPath(taskId, absolutePath) !== path) {
      throw new TaskStoreError('任务事实路径无效');
    }
    try {
      await access(absolutePath);
      throw new TaskStoreError(`任务事实已存在：${path}`);
    } catch (error) {
      if (error instanceof TaskStoreError) {
        throw error;
      }
    }
    await mkdir(dirname(absolutePath), { recursive: true });
    const temporaryPath = `${absolutePath}.tmp`;
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, absolutePath);
  }

  relativeTaskPath(taskId: string, absolutePath: string): string {
    const taskDirectory = resolve(this.taskDirectory(taskId));
    const resolved = resolve(absolutePath);
    const path = relative(taskDirectory, resolved);
    if (path.startsWith('..') || path === '') {
      throw new TaskStoreError('路径必须位于任务目录内');
    }
    return path.replaceAll('\\', '/');
  }

  private async writeTask(task: Task): Promise<void> {
    await this.writeTaskAt(this.taskDirectory(task.id), task);
  }

  private async writeTaskAt(directory: string, task: Task): Promise<void> {
    await mkdir(directory, { recursive: true });
    const taskPath = join(directory, 'task.yaml');
    const temporaryPath = `${taskPath}.tmp`;
    await writeFile(temporaryPath, stringify(task), 'utf8');
    await rename(temporaryPath, taskPath);
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
