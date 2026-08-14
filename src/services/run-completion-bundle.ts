import { access } from 'node:fs/promises';
import { join } from 'node:path';

import type { Task } from '../domain/task.js';
import { TaskStore } from './task-store.js';

export class RunCompletionBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunCompletionBundleError';
  }
}

export interface RunCompletionBundle {
  runId: string;
  paths: string[];
}

export async function loadRunCompletionBundle(task: Task, taskStore: TaskStore, nodeId: string): Promise<RunCompletionBundle> {
  const node = task.nodes[nodeId];
  if (node === undefined) {
    throw new RunCompletionBundleError(`未知节点：${nodeId}`);
  }
  if (node.phase === 'intake') {
    throw new RunCompletionBundleError('资料接入节点不生成运行完成包');
  }
  const event = [...task.events].reverse().find((candidate) => candidate.type === 'succeed' && candidate.nodeId === nodeId);
  if (event?.runId === undefined || event.evidencePath === undefined || event.outputs === undefined) {
    throw new RunCompletionBundleError(`节点 ${nodeId} 缺少可提交的完成运行包`);
  }
  const expectedEvidencePath = `runs/${event.runId}/change-evidence.json`;
  if (event.evidencePath !== expectedEvidencePath || !samePaths(event.outputs.map((output) => output.path), node.outputs)) {
    throw new RunCompletionBundleError(`节点 ${nodeId} 的完成运行包与当前产物声明不一致`);
  }
  const paths = [
    ...node.outputs,
    `runs/${event.runId}/context-manifest.json`,
    `runs/${event.runId}/change-baseline.json`,
    `runs/${event.runId}/change-scope.json`,
    `runs/${event.runId}/change-diff.json`,
    expectedEvidencePath,
    `runs/${event.runId}/result.json`,
  ];
  const missing = await missingPaths(taskStore, task.id, paths);
  if (missing.length > 0) {
    throw new RunCompletionBundleError(`节点 ${nodeId} 缺少可提交的完成运行包：${missing.join(', ')}`);
  }
  return { runId: event.runId, paths };
}

async function missingPaths(taskStore: TaskStore, taskId: string, paths: string[]): Promise<string[]> {
  const present = await Promise.all(paths.map(async (path) => {
    try {
      await access(join(taskStore.taskDirectory(taskId), path));
      return true;
    } catch {
      return false;
    }
  }));
  return paths.filter((_path, index) => !present[index]);
}

function samePaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((path) => right.includes(path));
}
