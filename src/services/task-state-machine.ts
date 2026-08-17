import { TaskSchema, type OutputRecord, type SkillLock, type Task, type TaskNode } from '../domain/task.js';

export type NodeEvent =
  | { type: 'evaluate' }
  | { type: 'rebind_skill'; skill: SkillLock; note: string }
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
      assertStatus(node, ['ready', 'failed'], '只能启动已就绪或可重试节点');
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
    case 'rebind_skill': {
      assertStatus(node, ['pending', 'ready', 'failed'], '只能重新绑定待执行或可重试节点的技能');
      assertNote(event.note);
      const previousSkill = node.skill;
      node.skill = event.skill;
      const afterRebind = invalidateDependents(next, nodeId, 'skill rebound');
      addEvent(afterRebind, 'rebind_skill', nodeId, { note: event.note, previousSkill, nextSkill: event.skill });
      return TaskSchema.parse(deriveTaskStatus(afterRebind));
    }
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

function assertStatus(node: TaskNode, allowed: TaskNode['status'][], message: string): void {
  if (!allowed.includes(node.status)) {
    throw new TaskTransitionError(message);
  }
}

function assertNote(note: string): void {
  if (note.trim().length === 0) {
    throw new TaskTransitionError('变更原因不能为空');
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
