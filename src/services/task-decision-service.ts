import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

import { DecisionRegisterSchema, type DecisionItem, type DecisionRegister } from '../domain/decision-register.js';
import { type DecisionResolution, type Task } from '../domain/task.js';
import { deriveTaskStatus, reconcileDecisionBlocks } from './task-state-machine.js';
import { TaskStore } from './task-store.js';

const registerPath = 'artifacts/decision-register.yaml';

export class TaskDecisionService {
  constructor(private readonly deps: { taskStore: TaskStore }) {}

  async list(taskId: string): Promise<Array<{ item: DecisionItem; resolution?: DecisionResolution }>> {
    const task = await this.deps.taskStore.load(taskId);
    const register = await this.readRegister(task);
    return register.items.map((item) => ({ item, resolution: task.decisions.find((decision) => decision.id === item.id) }));
  }

  async choose(input: {
    taskId: string;
    decisionId: string;
    optionId: string;
    actor: string;
    status: 'resolved' | 'waiting_external' | 'deferred' | 'waived';
    owner?: string;
    unblockCondition?: string;
    note?: string;
  }): Promise<Task> {
    const task = await this.deps.taskStore.load(input.taskId);
    const register = await this.readRegister(task);
    const proposal = this.findProposal(register, input.decisionId);
    if (!proposal.options.some((option) => option.id === input.optionId)) {
      throw new Error(`决策项不存在选项：${input.optionId}`);
    }
    if (input.status === 'waiting_external' && (input.owner === undefined || input.unblockCondition === undefined)) {
      throw new Error('外部等待决策必须提供责任人和解除条件');
    }
    if ((input.status === 'deferred' || input.status === 'waived') && (input.note === undefined || input.note.trim().length === 0)) {
      throw new Error('拆期或风险豁免必须提供说明');
    }
    return this.record(task, proposal, {
      status: input.status,
      optionId: input.optionId,
      actor: input.actor,
      ...(input.owner === undefined ? {} : { owner: input.owner }),
      ...(input.unblockCondition === undefined ? {} : { unblockCondition: input.unblockCondition }),
      ...(input.note === undefined ? {} : { note: input.note.trim() }),
    });
  }

  async resolve(input: { taskId: string; decisionId: string; actor: string; note: string }): Promise<Task> {
    const task = await this.deps.taskStore.load(input.taskId);
    const register = await this.readRegister(task);
    const proposal = this.findProposal(register, input.decisionId);
    const current = task.decisions.find((decision) => decision.id === input.decisionId);
    if (current?.status !== 'waiting_external') {
      throw new Error('只能解除等待外部条件的决策项');
    }
    return this.record(task, proposal, {
      status: 'resolved', optionId: current.optionId, actor: input.actor, note: input.note.trim(),
    });
  }

  private async record(
    task: Task,
    proposal: DecisionItem,
    input: Omit<DecisionResolution, 'id' | 'revision' | 'at' | 'factPath'>,
  ): Promise<Task> {
    const previous = task.decisions.find((decision) => decision.id === proposal.id);
    const revision = (previous?.revision ?? 0) + 1;
    const factPath = `decisions/${proposal.id}/r${revision}.yaml`;
    const resolution: DecisionResolution = {
      id: proposal.id,
      revision,
      at: new Date().toISOString(),
      factPath,
      ...input,
    };
    await this.deps.taskStore.createFact(task.id, factPath, stringify({
      schemaVersion: 'aiw.decision/v1',
      decision: proposal,
      resolution,
    }));
    task.decisions = [...task.decisions.filter((decision) => decision.id !== proposal.id), resolution];
    task.events.push({
      type: resolution.status === 'deferred' ? 'defer_decision' : resolution.status === 'resolved' && previous?.status === 'waiting_external' ? 'resolve_decision' : 'choose_decision',
      decisionId: proposal.id,
      at: resolution.at,
      actor: resolution.actor,
      ...(resolution.note === undefined ? {} : { note: resolution.note }),
    });
    const next = resolution.status === 'resolved' || resolution.status === 'waived' || resolution.status === 'deferred'
      ? reconcileDecisionBlocks(task, proposal.id)
      : deriveTaskStatus(task);
    await this.deps.taskStore.update(next);
    return next;
  }

  private async readRegister(task: Task): Promise<DecisionRegister> {
    try {
      return DecisionRegisterSchema.parse(parse(await readFile(join(this.deps.taskStore.taskDirectory(task.id), registerPath), 'utf8')));
    } catch {
      throw new Error(`无法读取决策登记：${registerPath}`);
    }
  }

  private findProposal(register: DecisionRegister, decisionId: string): DecisionItem {
    const proposal = register.items.find((item) => item.id === decisionId);
    if (proposal === undefined) throw new Error(`未知决策项：${decisionId}`);
    return proposal;
  }
}
