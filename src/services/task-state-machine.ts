import { TaskSchema, type OutputRecord, type Task, type TaskNode } from '../domain/task.js';

export type NodeEvent =
  | { type: 'evaluate' }
  | { type: 'start'; runId: string }
  | { type: 'succeed'; runId: string; outputs: OutputRecord[]; evidencePath: string }
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
  const node = getNode(next, nodeId);

  switch (event.type) {
    case 'evaluate':
      if (node.status === 'pending' && dependenciesCompleted(next, node)) {
        node.status = 'ready';
        addEvent(next, 'evaluate', nodeId);
      }
      break;
    case 'start':
      if (node.phase !== 'intake' && ['completed', 'awaiting_approval'].includes(node.status)) {
        resetForOverwrite(next, nodeId);
      } else {
        assertStatus(node, ['ready', 'failed'], '只能启动已就绪、可重试、已完成或待审批节点');
      }
      node.status = 'running';
      addEvent(next, 'start', nodeId, { runId: event.runId });
      break;
    case 'succeed':
      assertStatus(node, ['running'], '只能完成运行中的节点');
      node.revision += 1;
      node.status = node.requiresApproval ? 'awaiting_approval' : 'completed';
      addEvent(next, 'succeed', nodeId, { runId: event.runId, outputs: event.outputs, evidencePath: event.evidencePath });
      if (node.status === 'completed') {
        unlockDependents(next, nodeId);
      }
      break;
    case 'approve':
      assertStatus(node, ['awaiting_approval'], '只能批准等待审批的节点');
      node.status = 'completed';
      addEvent(next, 'approve', nodeId, { actor: event.actor, note: event.note });
      unlockDependents(next, nodeId);
      break;
    case 'fail':
      assertStatus(node, ['running'], '只能将运行中的节点标记为失败');
      node.status = 'failed';
      addEvent(next, 'fail', nodeId, { reason: event.message, ...(event.actor === undefined ? {} : { actor: event.actor }) });
      break;
    case 'cancel':
      assertStatus(node, ['running'], '只能取消运行中的节点');
      node.status = 'cancelled';
      addEvent(next, 'cancel', nodeId, { note: event.note });
      break;
  }

  return TaskSchema.parse(deriveTaskStatus(next));
}

export function invalidateDependents(task: Task, upstreamNodeId: string, reason: string): Task {
  const next = TaskSchema.parse(task);
  getNode(next, upstreamNodeId);
  const queue = [upstreamNodeId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentNodeId = queue.shift();
    if (currentNodeId === undefined || visited.has(currentNodeId)) {
      continue;
    }
    visited.add(currentNodeId);

    for (const [nodeId, node] of Object.entries(next.nodes)) {
      if (!node.dependsOn.includes(currentNodeId)) {
        continue;
      }

      queue.push(nodeId);
      if (node.status === 'pending' || node.status === 'invalidated' || node.status === 'superseded') {
        continue;
      }

      node.status = 'invalidated';
      addEvent(next, 'invalidate', nodeId, { reason });
    }
  }

  return TaskSchema.parse(deriveTaskStatus(next));
}

/** A source snapshot is the only mutable input. Its change restarts the downstream flow from the first affected node. */
export function restartDependentsForSourceChange(task: Task, upstreamNodeId: string, reason: string): Task {
  const next = invalidateDependents(task, upstreamNodeId, reason);
  for (const node of Object.values(next.nodes)) {
    if (node.status === 'invalidated') node.status = 'pending';
  }
  for (const [nodeId, node] of Object.entries(next.nodes)) {
    if (node.status === 'pending' && dependenciesCompleted(next, node)) {
      node.status = 'ready';
      addEvent(next, 'evaluate', nodeId, { reason: 'source changed' });
    }
  }
  return TaskSchema.parse(deriveTaskStatus(next));
}

/** Re-evaluate only nodes that explicitly declared the resolved decision as a blocker. */
export function reconcileDecisionBlocks(task: Task, decisionId: string): Task {
  const next = TaskSchema.parse(task);
  const resolution = next.decisions.find((decision) => decision.id === decisionId);
  if (resolution?.status === 'deferred') {
    for (const [nodeId, node] of Object.entries(next.nodes)) {
      if (!node.blockedByDecisionIds?.includes(decisionId) || !['blocked', 'pending', 'ready'].includes(node.status)) continue;
      node.status = 'superseded';
      node.blockedByDecisionIds = undefined;
      for (const dependent of Object.values(next.nodes)) {
        dependent.dependsOn = dependent.dependsOn.filter((dependency) => dependency !== nodeId);
      }
      addEvent(next, 'supersede', nodeId, { reason: `决策 ${decisionId} 已拆期` });
    }
    return TaskSchema.parse(deriveTaskStatus(next));
  }
  if (resolution?.status !== 'resolved' && resolution?.status !== 'waived') {
    return TaskSchema.parse(deriveTaskStatus(next));
  }
  for (const [nodeId, node] of Object.entries(next.nodes)) {
    if (node.status !== 'blocked' || !node.blockedByDecisionIds?.includes(decisionId)) continue;
    const unresolved = node.blockedByDecisionIds.some((blockedId) => {
      const current = next.decisions.find((decision) => decision.id === blockedId);
      return current === undefined || current.status === 'waiting_external';
    });
    if (!unresolved) {
      node.status = dependenciesCompleted(next, node) ? 'ready' : 'pending';
      node.blockedByDecisionIds = undefined;
      addEvent(next, 'evaluate', nodeId, { reason: `决策 ${decisionId} 已解除` });
    }
  }
  return TaskSchema.parse(deriveTaskStatus(next));
}

function getNode(task: Task, nodeId: string): TaskNode {
  const node = task.nodes[nodeId];
  if (node === undefined) {
    throw new TaskTransitionError(`未知节点：${nodeId}`);
  }
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

/** Re-running a completed stage replaces its active output and every downstream active output. */
function resetForOverwrite(task: Task, nodeId: string): void {
  const affected = [nodeId, ...downstreamNodeIds(task, nodeId)];
  const affectedSet = new Set(affected);
  const generatedImplementationIds = affected.filter((id) => id !== nodeId && task.nodes[id]?.phase === 'implement' && task.nodes[id]?.generatedFromPlanRevision !== undefined);

  for (const id of generatedImplementationIds) delete task.nodes[id];

  const implementation = task.nodes.implement;
  if (implementation !== undefined && affectedSet.has('implement')) {
    implementation.status = 'pending';
    implementation.dependsOn = ['plan'];
    implementation.blockedByDecisionIds = undefined;
  }

  for (const id of affected) {
    if (id === nodeId || id === 'implement' || generatedImplementationIds.includes(id)) continue;
    const node = task.nodes[id];
    if (node === undefined) continue;
    if (node.phase === 'verify' && generatedImplementationIds.length > 0) {
      node.dependsOn = [...new Set([
        ...node.dependsOn.filter((dependency) => !generatedImplementationIds.includes(dependency)),
        'implement',
      ])];
    }
    node.status = 'pending';
    node.blockedByDecisionIds = undefined;
    addEvent(task, 'invalidate', id, { reason: `重新执行 ${nodeId}，已覆盖上次结果` });
  }

  if (affectedSet.has('clarify')) task.decisions = [];
  if (affectedSet.has('test')) task.deliveryStatus = 'not_assessed';
  task.approvalRefs = task.approvalRefs.filter((path) => !affected.some((id) => path.startsWith(`approvals/${id}/`)));
}

/** Current task facts that must be deleted before a completed stage is re-run. Runtime records remain for debugging. */
export function overwriteCleanupPaths(task: Task, nodeId: string): string[] {
  const affected = [nodeId, ...downstreamNodeIds(task, nodeId)];
  const paths = affected.flatMap((id) => {
    const node = task.nodes[id];
    if (node === undefined) return [];
    return [
      ...node.outputs,
      ...(node.contextPath === undefined ? [] : [node.contextPath]),
      `handoffs/${id}`,
      `approvals/${id}`,
      `risk-acceptances/${id}`,
    ];
  });
  if (affected.includes('clarify')) paths.push('decisions');
  return [...new Set(paths)];
}

function downstreamNodeIds(task: Task, upstreamNodeId: string): string[] {
  const queue = [upstreamNodeId];
  const result: string[] = [];
  const visited = new Set<string>([upstreamNodeId]);
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
  if (!allowed.includes(node.status)) {
    throw new TaskTransitionError(message);
  }
}

function addEvent(
  task: Task,
  type: Task['events'][number]['type'],
  nodeId: string,
  detail: Omit<Task['events'][number], 'at' | 'nodeId' | 'type'> = {},
): void {
  task.events.push({ type, nodeId, at: new Date().toISOString(), ...detail });
}

export function deriveTaskStatus(task: Task): Task {
  const statuses = Object.values(task.nodes).map((node) => node.status);
  if (statuses.every((status) => status === 'completed' || status === 'superseded')) {
    task.status = 'completed';
    return task;
  }
  if (statuses.every((status) => status === 'completed' || status === 'cancelled' || status === 'superseded') && statuses.includes('cancelled')) {
    task.status = 'cancelled';
    return task;
  }
  const canProgress = statuses.some((status) => ['ready', 'running', 'awaiting_approval'].includes(status));
  const hasBlockedWork = statuses.some((status) => ['blocked', 'failed', 'invalidated'].includes(status));
  task.status = hasBlockedWork ? (canProgress ? 'partially_blocked' : 'blocked') : 'active';
  return task;
}
