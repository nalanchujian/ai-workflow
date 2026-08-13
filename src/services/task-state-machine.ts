import { TaskSchema, type OutputRecord, type SkillLock, type Task, type TaskNode } from '../domain/task.js';

export type NodeEvent =
  | { type: 'evaluate' }
  | { type: 'rebind_skill'; skill: SkillLock; note: string }
  | { type: 'start'; runId: string }
  | { type: 'succeed'; outputs: OutputRecord[]; evidencePath?: string }
  | { type: 'approve'; actor: string; note?: string }
  | { type: 'request_changes'; actor: string; note: string }
  | { type: 'revise'; actor: string; note: string }
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
      assertStatus(node, ['ready'], '只能启动已就绪节点');
      node.status = 'running';
      addEvent(next, 'start', nodeId, { runId: event.runId });
      break;
    case 'succeed':
      assertStatus(node, ['running'], '只能完成运行中的节点');
      node.revision += 1;
      node.status = node.requiresApproval ? 'awaiting_approval' : 'completed';
      addEvent(next, 'succeed', nodeId, { outputs: event.outputs, ...(event.evidencePath === undefined ? {} : { evidencePath: event.evidencePath }) });
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
    case 'request_changes': {
      assertStatus(node, ['awaiting_approval'], '只能要求修改等待审批的节点');
      assertNote(event.note);
      node.status = 'pending';
      const afterRequestedChanges = invalidateDependents(next, nodeId, 'approval changes requested');
      addEvent(afterRequestedChanges, 'request_changes', nodeId, { actor: event.actor, note: event.note });
      evaluateIfDependenciesCompleted(afterRequestedChanges, nodeId);
      return TaskSchema.parse(deriveTaskStatus(afterRequestedChanges));
    }
    case 'revise': {
      if (node.status === 'awaiting_approval') {
        throw new TaskTransitionError('等待审批节点必须使用 request_changes');
      }
      assertStatus(node, ['pending', 'ready', 'failed', 'invalidated', 'completed'], '当前节点不能修订');
      assertNote(event.note);
      node.status = 'pending';
      const afterRevision = invalidateDependents(next, nodeId, 'node revised');
      addEvent(afterRevision, 'revise', nodeId, { actor: event.actor, note: event.note });
      evaluateIfDependenciesCompleted(afterRevision, nodeId);
      return TaskSchema.parse(deriveTaskStatus(afterRevision));
    }
    case 'rebind_skill': {
      assertStatus(node, ['pending', 'ready', 'failed', 'invalidated'], '只能重新绑定待执行或失效节点的技能');
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
      if (node.status === 'pending' || node.status === 'invalidated') {
        continue;
      }

      node.status = 'invalidated';
      addEvent(next, 'invalidate', nodeId, { reason });
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

function evaluateIfDependenciesCompleted(task: Task, nodeId: string): void {
  const node = getNode(task, nodeId);
  if (node.status === 'pending' && dependenciesCompleted(task, node)) {
    node.status = 'ready';
    addEvent(task, 'evaluate', nodeId);
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

function deriveTaskStatus(task: Task): Task {
  const statuses = Object.values(task.nodes).map((node) => node.status);
  if (statuses.every((status) => status === 'completed')) {
    task.status = 'completed';
    return task;
  }
  if (statuses.every((status) => status === 'completed' || status === 'cancelled') && statuses.includes('cancelled')) {
    task.status = 'cancelled';
    return task;
  }
  const canProgress = statuses.some((status) => ['ready', 'running', 'awaiting_approval'].includes(status));
  const hasBlockedWork = statuses.some((status) => ['failed', 'invalidated'].includes(status));
  task.status = hasBlockedWork && !canProgress ? 'blocked' : 'active';
  return task;
}
