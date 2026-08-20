import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

import { DecisionRegisterSchema, type DecisionItem, type DecisionRegister } from '../domain/decision-register.js';
import { ExternalDecisionInputSchema } from '../domain/external-decision-input.js';
import { completedArtifactPath } from '../domain/handoff.js';
import { type DecisionResolution, type ExternalResolutionImpact, type Task } from '../domain/task.js';
import { deriveTaskStatus, invalidateNodeAndDependents, reconcileDecisionBlocks } from './task-state-machine.js';
import { TaskStore } from './task-store.js';

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
    status: 'resolved' | 'waiting_external';
    owner?: string;
    unblockCondition?: string;
    note?: string;
  }): Promise<Task> {
    const task = await this.deps.taskStore.load(input.taskId);
    const register = await this.readRegister(task);
    const proposal = this.findProposal(register, input.decisionId);
    const manual = input.optionId === 'manual';
    const option = proposal.options.find((candidate) => candidate.id === input.optionId);
    if (!manual && option === undefined) {
      throw new Error(`决策项不存在选项：${input.optionId}`);
    }
    if (manual && (input.note === undefined || input.note.trim().length === 0)) {
      throw new Error('人工输入的决策结论不能为空');
    }
    if (input.status === 'waiting_external' && (input.owner === undefined || input.unblockCondition === undefined)) {
      throw new Error('外部等待决策必须提供责任人和解除条件');
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

  async resolve(input: {
    taskId: string;
    decisionId: string;
    actor: string;
    impact: ExternalResolutionImpact;
    fact?: string;
    evidence?: string;
    note: string;
  }): Promise<Task> {
    const task = await this.deps.taskStore.load(input.taskId);
    const register = await this.readRegister(task);
    const proposal = this.findProposal(register, input.decisionId);
    const current = task.decisions.find((decision) => decision.id === input.decisionId);
    if (current?.status !== 'waiting_external') {
      throw new Error('只能解除等待外部条件的决策项');
    }
    const fact = input.fact?.trim();
    if (input.impact === 'replan' && (fact === undefined || fact.length < 16)) {
      throw new Error('重新规划必须提供新增事实，且至少包含 16 个字符');
    }
    const inputFactPath = input.impact === 'replan'
      ? `external-inputs/${proposal.id}.yaml`
      : undefined;
    if (inputFactPath !== undefined) {
      const recordedAt = new Date().toISOString();
      const externalFact = ExternalDecisionInputSchema.parse({
        schemaVersion: 'aiw.external-decision-input/v1',
        decisionId: proposal.id,
        summary: fact,
        ...(input.evidence === undefined || input.evidence.trim().length === 0 ? {} : { evidence: input.evidence.trim() }),
        recordedBy: input.actor,
        recordedAt,
      });
      await this.deps.taskStore.replaceFact(task.id, inputFactPath, stringify(externalFact));
    }
    return this.record(task, proposal, {
      status: 'resolved',
      optionId: current.optionId,
      actor: input.actor,
      note: input.note.trim(),
      resolutionImpact: input.impact,
      ...(inputFactPath === undefined ? {} : { inputFactPath }),
    });
  }

  private async record(
    task: Task,
    proposal: DecisionItem,
    input: Omit<DecisionResolution, 'id' | 'at' | 'factPath'>,
  ): Promise<Task> {
    const previous = task.decisions.find((decision) => decision.id === proposal.id);
    const factPath = `decisions/${proposal.id}.yaml`;
    const resolution: DecisionResolution = {
      id: proposal.id,
      at: new Date().toISOString(),
      factPath,
      ...input,
    };
    await this.deps.taskStore.replaceFact(task.id, factPath, stringify({
      schemaVersion: 'aiw.decision/v1',
      decision: proposal,
      resolution,
    }));
    task.decisions = [...task.decisions.filter((decision) => decision.id !== proposal.id), resolution];
    task.events.push({
      type: resolution.status === 'resolved' && previous?.status === 'waiting_external' ? 'resolve_decision' : 'choose_decision',
      decisionId: proposal.id,
      at: resolution.at,
      actor: resolution.actor,
      ...(resolution.note === undefined ? {} : { note: resolution.note }),
    });
    const requiresReplan = previous?.status === 'waiting_external' && resolution.status === 'resolved' && resolution.resolutionImpact === 'replan';
    const next = requiresReplan
      // A replan introduces a new business input. Although the impact graph can
      // identify the candidate units, today's solution and plan are shared
      // current artifacts; letting a unit run against stale content would make
      // the graph look precise while using a stale design. Only the
      // execution-only path may unlock a unit directly.
      ? invalidateNodeAndDependents(task, 'solution', `决策 ${proposal.id} 已补充影响方案的新事实；必须重新生成技术方案和实施计划`)
      : resolution.status === 'resolved'
        ? reconcileDecisionBlocks(task, proposal.id)
        : deriveTaskStatus(task);
    return this.deps.taskStore.update(next);
  }

  private async readRegister(task: Task): Promise<DecisionRegister> {
    const clarify = task.nodes.clarify;
    const registerPath = clarify?.hasResult !== true
      ? undefined
      : completedArtifactPath('clarify', clarify, 'artifacts/decision-register.yaml');
    if (registerPath === undefined) {
      throw new Error('无法读取决策登记：需求澄清尚未生成当前结果');
    }
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
