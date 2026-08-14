import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { stringify } from 'yaml';
import { z } from 'zod';

import { TaskSchema, type SkillLock, type Task, type TaskNode } from '../domain/task.js';
import type { SkillRegistry } from '../services/skill-registry.js';
import { TaskFactGuard } from '../services/task-fact-guard.js';
import { deriveTaskStatus, transitionNode } from '../services/task-state-machine.js';
import { TaskStore } from '../services/task-store.js';
import { loadRunCompletionBundle } from '../services/run-completion-bundle.js';
import { type HumanOutput, writeCommandResult } from './output.js';

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

  async addSubtask(taskId: string, nodeId: string, options: { title: string; dependsOn: string[]; before: string[]; requiresApproval: boolean }): Promise<Task> {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(nodeId)) throw new Error('子任务节点 ID 格式无效');
    const task = await this.deps.taskStore.load(taskId);
    if (task.nodes[nodeId] !== undefined) throw new Error(`子任务节点已存在：${nodeId}`);
    const dependencies = [...new Set(options.dependsOn.length === 0 ? ['plan'] : options.dependsOn)];
    const mergeTargets = [...new Set(options.before.length === 0 ? ['verify'] : options.before)];
    for (const dependency of dependencies) if (task.nodes[dependency] === undefined) throw new Error(`未知依赖节点：${dependency}`);
    for (const target of mergeTargets) {
      const node = task.nodes[target];
      if (node === undefined) throw new Error(`未知汇合节点：${target}`);
      if (node.status !== 'pending') throw new Error(`只能在未开始的节点前汇合：${target}`);
    }
    const template = task.nodes.implement;
    if (template?.skill === undefined) throw new Error('任务未锁定实施技能，无法创建子任务');
    const title = options.title.trim();
    if (title.length === 0) throw new Error('子任务标题不能为空');
    const subtask: TaskNode = {
      title, phase: 'implement', dependsOn: dependencies, skill: template.skill,
      requiresApproval: options.requiresApproval,
      status: dependencies.every((dependency) => task.nodes[dependency]?.status === 'completed') ? 'ready' : 'pending',
      revision: 0, outputs: [`artifacts/subtasks/${nodeId}.md`],
    };
    task.nodes[nodeId] = subtask;
    for (const target of mergeTargets) task.nodes[target]!.dependsOn = [...new Set([...task.nodes[target]!.dependsOn, nodeId])];
    task.events.push({ type: 'add_subtask', nodeId, at: new Date().toISOString(), note: `依赖：${dependencies.join('、')}；汇合：${mergeTargets.join('、')}` });
    const next = TaskSchema.parse(deriveTaskStatus(task));
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
    const completionBundle = await loadRunCompletionBundle(task, this.deps.taskStore, nodeId);
    await this.deps.taskFactGuard.assertCommitted({ task, projectRoot: this.deps.taskStore.projectDirectory(), paths: ['task.yaml', ...completionBundle.paths] });
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
  command.addCommand(new Command('status').argument('<task-id>').option('--project <path>', '业务仓库根目录；默认当前目录').action(async (taskId: string, _options: unknown, current: Command) => {
    const task = await deps.commands.status(taskId);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, '任务状态'));
  }));
  command.addCommand(new Command('approve').argument('<task-id>').argument('<node-id>').option('--project <path>', '业务仓库根目录；默认当前目录').option('--actor <name>').option('--note <text>').action(async (taskId: string, nodeId: string, options: { actor?: string; note?: string }, current: Command) => {
    const task = await deps.commands.approve(taskId, nodeId, options);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `「${nodeId}」节点已批准`));
  }));
  command.addCommand(new Command('request-changes').argument('<task-id>').argument('<node-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--note <text>').option('--actor <name>').action(async (taskId: string, nodeId: string, options: { actor?: string; note: string }, current: Command) => {
    const task = await deps.commands.requestChanges(taskId, nodeId, options);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `「${nodeId}」节点已退回修改`));
  }));
  command.addCommand(new Command('fail').argument('<task-id>').argument('<node-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--note <text>').option('--actor <name>').action(async (taskId: string, nodeId: string, options: { actor?: string; note: string }, current: Command) => {
    const task = await deps.commands.fail(taskId, nodeId, options);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `「${nodeId}」节点已标记失败`));
  }));
  command.addCommand(new Command('revise').argument('<task-id>').argument('<node-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--note <text>').option('--actor <name>').action(async (taskId: string, nodeId: string, options: { actor?: string; note: string }, current: Command) => {
    const task = await deps.commands.revise(taskId, nodeId, options);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `「${nodeId}」节点已进入修订`));
  }));
  command.addCommand(new Command('skill').addCommand(new Command('rebind').argument('<task-id>').argument('<node-id>').option('--project <path>', '业务仓库根目录；默认当前目录').requiredOption('--skill <name@version>').requiredOption('--note <text>').action(async (taskId: string, nodeId: string, options: { skill: string; note: string }, current: Command) => {
    const task = await deps.commands.rebindSkill(taskId, nodeId, options);
    writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `「${nodeId}」节点技能已更新`));
  })));
  command.addCommand(new Command('subtask').description('为复杂实施任务添加可并行子节点')
    .addCommand(new Command('add').argument('<task-id>').argument('<node-id>')
      .option('--project <path>', '业务仓库根目录；默认当前目录')
      .requiredOption('--title <title>', '子任务标题')
      .option('--depends-on <node-id>', '依赖节点；可重复，默认 plan', collect, [])
      .option('--before <node-id>', '完成后必须汇合的未开始节点；可重复，默认 verify', collect, [])
      .option('--requires-approval', '子任务完成后等待人工审批')
      .action(async (taskId: string, nodeId: string, options: { title: string; dependsOn: string[]; before: string[]; requiresApproval?: boolean }, current: Command) => {
        const task = await deps.commands.addSubtask(taskId, nodeId, { ...options, requiresApproval: options.requiresApproval ?? false });
        writeCommandResult(task, current, deps.stdout, renderTaskOutput(task, `子任务「${nodeId}」已创建`));
      })));
  return command;
}

function renderTaskOutput(task: Task, headline: string): HumanOutput {
  const ready = Object.entries(task.nodes).find(([, node]) => node.status === 'ready');
  const waiting = Object.entries(task.nodes).find(([, node]) => node.status === 'awaiting_approval');
  return {
    headline,
    details: [
      { label: '任务 ID', value: task.id },
      { label: '任务名称', value: task.title },
      { label: '整体状态', value: taskStatusLabel(task.status) },
    ],
    sections: [{ title: '节点', lines: Object.entries(task.nodes).map(([nodeId, node]) => `${nodeId}（${node.title}）：${nodeStatusLabel(node.status)}`) }],
    nextSteps: ready === undefined && waiting === undefined ? undefined : [
      ...(waiting === undefined ? [] : [`aiw task approve ${task.id} ${waiting[0]} --note "<审批说明>"`]),
      ...(ready === undefined ? [] : [`aiw task run ${task.id} ${ready[0]}`]),
    ],
  };
}

function taskStatusLabel(status: Task['status']): string {
  return ({ active: '进行中', blocked: '需处理', completed: '已完成', cancelled: '已取消' })[status];
}

function nodeStatusLabel(status: TaskNode['status']): string {
  return ({ pending: '待开始', ready: '可执行', running: '运行中', awaiting_approval: '待审批', completed: '已完成', failed: '失败', invalidated: '已失效', cancelled: '已取消' })[status];
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
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
