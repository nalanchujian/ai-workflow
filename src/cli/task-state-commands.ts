import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { stringify } from 'yaml';
import { z } from 'zod';

import type { SkillLock, Task } from '../domain/task.js';
import type { SkillRegistry } from '../services/skill-registry.js';
import { TaskFactGuard } from '../services/task-fact-guard.js';
import { transitionNode } from '../services/task-state-machine.js';
import { TaskStore } from '../services/task-store.js';
import { writeCommandResult } from './output.js';

const ApprovalFactSchema = z.object({
  nodeId: z.string().min(1),
  nodeRevision: z.number().int().positive(),
  artifactHashes: z.record(z.string(), z.string().regex(/^sha256:[a-f0-9]{64}$/)),
  decision: z.enum(['approved', 'changes_requested']),
  actor: z.string().min(1),
  at: z.string().datetime(),
  note: z.string().optional(),
});

export class TaskStateCommands {
  constructor(private readonly deps: { taskStore: TaskStore; taskFactGuard: TaskFactGuard; skillRegistry?: SkillRegistry }) {}

  async status(taskId: string): Promise<Task> {
    return this.deps.taskStore.load(taskId);
  }

  async approve(taskId: string, nodeId: string, options: { actor?: string; note?: string }): Promise<Task> {
    return this.decide(taskId, nodeId, 'approved', options);
  }

  async requestChanges(taskId: string, nodeId: string, options: { actor?: string; note: string }): Promise<Task> {
    return this.decide(taskId, nodeId, 'changes_requested', options);
  }

  async fail(taskId: string, nodeId: string, options: { actor?: string; note: string }): Promise<Task> {
    const task = await this.deps.taskStore.load(taskId);
    const actor = await this.deps.taskFactGuard.actor(options.actor);
    const next = transitionNode(task, nodeId, { type: 'fail', message: options.note.trim(), actor });
    await this.deps.taskStore.update(next);
    return next;
  }

  async revise(taskId: string, nodeId: string, options: { actor?: string; note: string }): Promise<Task> {
    const task = await this.deps.taskStore.load(taskId);
    const next = transitionNode(task, nodeId, { type: 'revise', actor: await this.deps.taskFactGuard.actor(options.actor), note: options.note });
    const node = task.nodes[nodeId];
    if (node === undefined) {
      throw new Error(`未知节点：${nodeId}`);
    }
    await this.deps.taskStore.createFact(taskId, `revisions/${nodeId}/r${node.revision + 1}.md`, `${options.note.trim()}\n`);
    await this.deps.taskStore.update(next);
    return next;
  }

  async rebindSkill(taskId: string, nodeId: string, options: { skill: string; note: string }): Promise<Task> {
    if (this.deps.skillRegistry === undefined) {
      throw new Error('技能注册表不可用');
    }
    const [name, version] = parseReference(options.skill);
    const skill = await this.deps.skillRegistry.find(name, version);
    if (skill === undefined) {
      throw new Error('技能不存在');
    }
    const task = await this.deps.taskStore.load(taskId);
    const node = task.nodes[nodeId];
    if (node === undefined) {
      throw new Error(`未知节点：${nodeId}`);
    }
    if (!skill.phases.includes(node.phase as typeof skill.phases[number])) {
      throw new Error('技能与节点阶段不兼容');
    }
    const next = transitionNode(task, nodeId, { type: 'rebind_skill', skill: lockSkill(skill), note: options.note });
    await this.deps.taskStore.update(next);
    return next;
  }

  private async decide(
    taskId: string,
    nodeId: string,
    decision: 'approved' | 'changes_requested',
    options: { actor?: string; note?: string },
  ): Promise<Task> {
    const task = await this.deps.taskStore.load(taskId);
    const node = task.nodes[nodeId];
    if (node === undefined) {
      throw new Error(`未知节点：${nodeId}`);
    }
    if (node.status !== 'awaiting_approval') {
      throw new Error('只能审批等待审批的节点');
    }
    const note = options.note?.trim();
    if (decision === 'changes_requested' && (note === undefined || note.length === 0)) {
      throw new Error('变更说明不能为空');
    }
    const outputPaths = node.outputs;
    await this.deps.taskFactGuard.assertCommitted({ task, paths: ['task.yaml', ...outputPaths] });
    const actor = await this.deps.taskFactGuard.actor(options.actor);
    const artifactHashes = await outputHashes(task, this.deps.taskStore, nodeId);
    const approvalPath = `approvals/${nodeId}/r${node.revision}.yaml`;
    const approval = ApprovalFactSchema.parse({
      nodeId,
      nodeRevision: node.revision,
      artifactHashes,
      decision,
      actor,
      at: new Date().toISOString(),
      ...(note === undefined ? {} : { note }),
    });
    await this.deps.taskStore.createFact(taskId, approvalPath, stringify(approval));
    if (decision === 'changes_requested') {
      await this.deps.taskStore.createFact(taskId, `revisions/${nodeId}/r${node.revision + 1}.md`, `${note}\n`);
    }
    const next = transitionNode(task, nodeId, decision === 'approved'
      ? { type: 'approve', actor, ...(note === undefined ? {} : { note }) }
      : { type: 'request_changes', actor, note: note ?? '' });
    next.approvalRefs.push(approvalPath);
    await this.deps.taskStore.update(next);
    return next;
  }
}

export function createTaskStateCommand(deps: { commands: TaskStateCommands; stdout: NodeJS.WriteStream }): Command {
  const command = new Command('task').description('查询任务状态并处理审批');
  command.addCommand(new Command('status').argument('<task-id>').action(async (taskId: string, _options: unknown, current: Command) => {
    writeCommandResult(await deps.commands.status(taskId), current, deps.stdout);
  }));
  command.addCommand(new Command('approve').argument('<task-id>').argument('<node-id>').option('--actor <name>').option('--note <text>').action(async (taskId: string, nodeId: string, options: { actor?: string; note?: string }, current: Command) => {
    writeCommandResult(await deps.commands.approve(taskId, nodeId, options), current, deps.stdout);
  }));
  command.addCommand(new Command('request-changes').argument('<task-id>').argument('<node-id>').requiredOption('--note <text>').option('--actor <name>').action(async (taskId: string, nodeId: string, options: { actor?: string; note: string }, current: Command) => {
    writeCommandResult(await deps.commands.requestChanges(taskId, nodeId, options), current, deps.stdout);
  }));
  command.addCommand(new Command('fail').argument('<task-id>').argument('<node-id>').requiredOption('--note <text>').option('--actor <name>').action(async (taskId: string, nodeId: string, options: { actor?: string; note: string }, current: Command) => {
    writeCommandResult(await deps.commands.fail(taskId, nodeId, options), current, deps.stdout);
  }));
  command.addCommand(new Command('revise').argument('<task-id>').argument('<node-id>').requiredOption('--note <text>').option('--actor <name>').action(async (taskId: string, nodeId: string, options: { actor?: string; note: string }, current: Command) => {
    writeCommandResult(await deps.commands.revise(taskId, nodeId, options), current, deps.stdout);
  }));
  command.addCommand(new Command('skill').addCommand(new Command('rebind').argument('<task-id>').argument('<node-id>').requiredOption('--skill <name@version>').requiredOption('--note <text>').action(async (taskId: string, nodeId: string, options: { skill: string; note: string }, current: Command) => {
    writeCommandResult(await deps.commands.rebindSkill(taskId, nodeId, options), current, deps.stdout);
  })));
  return command;
}

async function outputHashes(task: Task, taskStore: TaskStore, nodeId: string): Promise<Record<string, string>> {
  const node = task.nodes[nodeId];
  if (node === undefined) {
    throw new Error(`未知节点：${nodeId}`);
  }
  const hashes = await Promise.all(node.outputs.map(async (path) => {
    const content = await readFile(taskStore.taskDirectory(task.id) + `/${path}`);
    return [path, `sha256:${createHash('sha256').update(content).digest('hex')}`] as const;
  }));
  return Object.fromEntries(hashes);
}

function parseReference(reference: string): [string, string] {
  const match = /^([a-z][a-z0-9-]*)@(\d+\.\d+\.\d+)$/.exec(reference);
  if (match === null) {
    throw new Error('技能引用格式无效');
  }
  return [match[1], match[2]];
}

function lockSkill(skill: { name: string; version: string; registrySource: SkillLock['registrySource']; sha256: string; methodSources: SkillLock['methodSources'] }): SkillLock {
  return { name: skill.name, version: skill.version, registrySource: skill.registrySource, sha256: skill.sha256, methodSources: skill.methodSources };
}
