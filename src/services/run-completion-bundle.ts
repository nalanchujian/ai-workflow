import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

import { ApprovalFactSchema } from '../domain/approval.js';
import type { Task } from '../domain/task.js';
import { outputPathsForCompletedRun } from '../domain/handoff.js';
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
  const outputPaths = event.outputs.map((output) => output.path);
  const expectedCurrentPaths = outputPathsForCompletedRun(nodeId, node);
  if (event.evidencePath !== expectedEvidencePath || !samePaths(outputPaths, expectedCurrentPaths)) {
    throw new RunCompletionBundleError(`节点 ${nodeId} 的完成运行包与当前产物声明不一致`);
  }
  const paths = [
    ...outputPaths,
    `runs/${event.runId}/context-manifest.json`,
    `runs/${event.runId}/change-baseline.json`,
    `runs/${event.runId}/change-scope.json`,
    `runs/${event.runId}/change-diff.json`,
    `runs/${event.runId}/change.patch`,
    expectedEvidencePath,
    `runs/${event.runId}/result.json`,
  ];
  const missing = await missingPaths(taskStore, task.id, paths);
  if (missing.length > 0) {
    throw new RunCompletionBundleError(`节点 ${nodeId} 缺少可提交的完成运行包：${missing.join(', ')}`);
  }
  const currentHashes = await artifactHashes(taskStore, task.id, event.outputs);
  for (const output of event.outputs) {
    if (currentHashes.get(output.path) !== output.sha256) {
      throw new RunCompletionBundleError(
        `节点 ${nodeId} 的完成产物哈希不一致：${output.path}（运行记录为 ${output.sha256}，当前为 ${currentHashes.get(output.path)}）`,
      );
    }
  }
  if (node.requiresApproval && node.status === 'completed') {
    await assertApprovalMatchesCompletion(taskStore, task, nodeId, node.revision, event.outputs);
  }
  return { runId: event.runId, paths };
}

async function artifactHashes(
  taskStore: TaskStore,
  taskId: string,
  outputs: Array<{ path: string }>,
): Promise<Map<string, string>> {
  const values = await Promise.all(outputs.map(async ({ path }) => {
    const content = await readFile(join(taskStore.taskDirectory(taskId), path));
    return [path, createHash('sha256').update(content).digest('hex')] as const;
  }));
  return new Map(values);
}

async function assertApprovalMatchesCompletion(
  taskStore: TaskStore,
  task: Task,
  nodeId: string,
  revision: number,
  outputs: Array<{ path: string; sha256: string }>,
): Promise<void> {
  const path = `approvals/${nodeId}/r${revision}.yaml`;
  if (!task.approvalRefs.includes(path)) {
    throw new RunCompletionBundleError(`节点 ${nodeId} 的审批记录未被当前任务引用：${path}`);
  }
  let approval;
  try {
    approval = ApprovalFactSchema.parse(parse(await readFile(join(taskStore.taskDirectory(task.id), path), 'utf8')));
  } catch {
    throw new RunCompletionBundleError(`节点 ${nodeId} 缺少与当前完成产物对应的审批记录：${path}`);
  }
  if (approval.nodeId !== nodeId || approval.nodeRevision !== revision) {
    throw new RunCompletionBundleError(`节点 ${nodeId} 的审批记录与当前节点 revision 不一致：${path}`);
  }
  for (const output of outputs) {
    if (approval.artifactHashes[output.path] !== `sha256:${output.sha256}`) {
      throw new RunCompletionBundleError(`节点 ${nodeId} 的审批记录与完成运行不一致：${output.path}`);
    }
  }
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
