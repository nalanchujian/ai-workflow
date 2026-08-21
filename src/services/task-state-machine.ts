import { TaskSchema, type OutputRecord, type Task, type TaskNode } from '../domain/task.js';

export type NodeEvent =
  | { type: 'evaluate' }
  | { type: 'start'; runId: string }
  | { type: 'succeed'; runId: string; outputs: OutputRecord[] }
  | { type: 'approve'; actor: string; note?: string }
  | { type: 'fail'; message: string; actor?: string }
  | { type: 'cancel'; note: string };

export class TaskTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskTransitionError';
  }
}

export function transitionNode(task: Task, nodeId: string, event: NodeEvent): Task {
  const next = TaskSchema.parse(task);
  let node = getNode(next, nodeId);

  if (event.type === 'evaluate') {
    if (node.status === 'pending' && dependenciesCompleted(next, node)) {
      node.status = 'ready';
      addEvent(next, 'evaluate', nodeId);
    }
    return TaskSchema.parse(deriveTaskStatus(next));
  }

  if (event.type === 'start') {
    if (node.phase === 'intake') throw new TaskTransitionError('资料接入节点不能通过 task run 执行');
    if (['completed', 'awaiting_approval', 'cancelled', 'invalidated'].includes(node.status)) {
      resetForOverwrite(next, nodeId);
      node = getNode(next, nodeId);
    } else {
      assertStatus(node, ['ready', 'failed'], '只能启动已就绪、失败、已完成、待确认或已失效节点');
    }
    node.status = 'running';
    node.hasResult = false;
    addEvent(next, 'start', nodeId, { runId: event.runId });
    return TaskSchema.parse(deriveTaskStatus(next));
  }

  if (event.type === 'succeed') {
    assertStatus(node, ['running'], '只能完成运行中的节点');
    node.hasResult = true;
    node.status = node.requiresApproval ? 'awaiting_approval' : 'completed';
    addEvent(next, 'succeed', nodeId, { runId: event.runId, outputs: event.outputs });
    if (node.status === 'completed') unlockDependents(next, nodeId);
  } else if (event.type === 'approve') {
    assertStatus(node, ['awaiting_approval'], '只能批准等待确认的节点');
    node.status = 'completed';
    addEvent(next, 'approve', nodeId, { actor: event.actor, ...(event.note === undefined ? {} : { note: event.note }) });
    unlockDependents(next, nodeId);
  } else if (event.type === 'fail') {
    assertStatus(node, ['running'], '只能将运行中的节点标记为失败');
    node.status = 'failed';
    addEvent(next, 'fail', nodeId, { reason: event.message, ...(event.actor === undefined ? {} : { actor: event.actor }) });
  } else {
    assertStatus(node, ['running'], '只能取消运行中的节点');
    node.status = 'cancelled';
    addEvent(next, 'cancel', nodeId, { note: event.note });
  }

  return TaskSchema.parse(deriveTaskStatus(next));
}

export function invalidateDependents(task: Task, upstreamNodeId: string, reason: string): Task {
  const next = TaskSchema.parse(task);
  getNode(next, upstreamNodeId);
  for (const nodeId of downstreamNodeIds(next, upstreamNodeId)) {
    const node = next.nodes[nodeId];
    if (node === undefined) continue;
    node.status = 'invalidated';
    node.hasResult = false;
    addEvent(next, 'invalidate', nodeId, { reason });
  }
  return TaskSchema.parse(deriveTaskStatus(next));
}

export function invalidateNodeAndDependents(task: Task, nodeId: string, reason: string): Task {
  const next = TaskSchema.parse(task);
  const affected = [nodeId, ...downstreamNodeIds(next, nodeId)];
  for (const id of affected) {
    const node = next.nodes[id];
    if (node === undefined) continue;
    node.status = 'invalidated';
    node.hasResult = false;
    addEvent(next, 'invalidate', id, { reason });
  }
  next.approvalRefs = next.approvalRefs.filter((path) => !affected.some((id) => path === `approvals/${id}.yaml`));
  return TaskSchema.parse(deriveTaskStatus(next));
}

export function restartDependentsForSourceChange(task: Task, upstreamNodeId: string, reason: string): Task {
  const next = TaskSchema.parse(task);
  getNode(next, upstreamNodeId);
  for (const id of downstreamNodeIds(next, upstreamNodeId)) {
    if (next.nodes[id]?.generatedFromPlan === true) {
      delete next.nodes[id];
      continue;
    }
    const node = next.nodes[id];
    if (node === undefined) continue;
    node.status = 'pending';
    node.hasResult = false;
    addEvent(next, 'invalidate', id, { reason });
  }
  for (const [id, node] of Object.entries(next.nodes)) {
    if (node.status === 'pending' && dependenciesCompleted(next, node)) {
      node.status = 'ready';
      addEvent(next, 'evaluate', id, { reason });
    }
  }
  next.approvalRefs = [];
  return TaskSchema.parse(deriveTaskStatus(next));
}

function resetForOverwrite(task: Task, nodeId: string): void {
  const affected = [nodeId, ...downstreamNodeIds(task, nodeId)];
  for (const id of affected) {
    if (id !== nodeId && task.nodes[id]?.generatedFromPlan === true) {
      delete task.nodes[id];
      continue;
    }
    const node = task.nodes[id];
    if (node === undefined) continue;
    node.status = id === nodeId ? node.status : 'pending';
    node.hasResult = false;
    if (id !== nodeId) addEvent(task, 'invalidate', id, { reason: `重新执行 ${nodeId}，下游结果已失效` });
  }
  task.approvalRefs = task.approvalRefs.filter((path) => !affected.some((id) => path === `approvals/${id}.yaml`));
}

function getNode(task: Task, nodeId: string): TaskNode {
  const node = task.nodes[nodeId];
  if (node === undefined) throw new TaskTransitionError(`未知节点：${nodeId}`);
  return node;
}

function dependenciesCompleted(task: Task, node: TaskNode): boolean {
  return node.dependsOn.every((dependency) => task.nodes[dependency]?.status === 'completed');
}

function unlockDependents(task: Task, upstreamNodeId: string): void {
  for (const [nodeId, node] of Object.entries(task.nodes)) {
    if (node.status === 'pending' && node.dependsOn.includes(upstreamNodeId) && dependenciesCompleted(task, node)) {
      node.status = 'ready';
      addEvent(task, 'evaluate', nodeId);
    }
  }
}

function downstreamNodeIds(task: Task, upstreamNodeId: string): string[] {
  const result: string[] = [];
  const queue = [upstreamNodeId];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [nodeId, node] of Object.entries(task.nodes)) {
      if (!node.dependsOn.includes(current) || visited.has(nodeId)) continue;
      visited.add(nodeId);
      result.push(nodeId);
      queue.push(nodeId);
    }
  }
  return result;
}

function assertStatus(node: TaskNode, allowed: TaskNode['status'][], message: string): void {
  if (!allowed.includes(node.status)) throw new TaskTransitionError(message);
}

function addEvent(
  task: Task,
  type: Task['events'][number]['type'],
  nodeId: string | undefined,
  detail: Omit<Task['events'][number], 'at' | 'nodeId' | 'type'> = {},
): void {
  task.events.push({ type, ...(nodeId === undefined ? {} : { nodeId }), at: new Date().toISOString(), ...detail });
}

export function deriveTaskStatus(task: Task): Task {
  const nodes = Object.values(task.nodes);
  if (nodes.length > 0 && nodes.every((node) => node.status === 'completed')) {
    task.status = 'completed';
    return task;
  }
  if (nodes.some((node) => ['ready', 'running', 'awaiting_approval', 'pending'].includes(node.status))) {
    task.status = 'active';
    return task;
  }
  if (nodes.some((node) => node.status === 'failed' || node.status === 'invalidated')) {
    task.status = 'blocked';
    return task;
  }
  task.status = 'cancelled';
  return task;
}
