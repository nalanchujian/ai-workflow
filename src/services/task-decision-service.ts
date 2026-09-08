import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

import { DecisionRegisterSchema, type DecisionRegister, type PendingDecision } from '../domain/decision-register.js';
import { TaskStore } from './task-store.js';

export type RequirementDecisionSelection =
  | { index: number; action: 'continue'; option: number; rationale?: string }
  | { index: number; action: 'defer'; reason: string; suggestedNextStep?: string };

export class TaskDecisionService {
  constructor(private readonly deps: { taskStore: TaskStore }) {}

  async read(taskId: string): Promise<DecisionRegister> {
    const path = join(this.deps.taskStore.taskDirectory(taskId), 'artifacts/requirement-analysis/decision-register.yaml');
    return DecisionRegisterSchema.parse(parse(await readFile(path, 'utf8')));
  }

  async pending(taskId: string): Promise<PendingDecision[]> {
    return (await this.read(taskId)).pendingDecisions;
  }

  async apply(taskId: string, selections: RequirementDecisionSelection[]): Promise<DecisionRegister> {
    const register = await this.read(taskId);
    if (selections.length !== register.pendingDecisions.length) throw new Error('必须逐项处理全部待确认事项');
    const used = new Set<number>();
    for (const selection of selections) {
      if (used.has(selection.index)) throw new Error('同一待确认事项不能重复处理');
      used.add(selection.index);
      const item = register.pendingDecisions[selection.index];
      if (item === undefined) throw new Error(`待确认事项序号无效：${selection.index + 1}`);
      if (selection.action === 'continue') {
        const option = item.options[selection.option];
        if (option === undefined) throw new Error(`方案序号无效：${selection.option + 1}`);
        register.currentDecisions.push({ question: item.question, selectedApproach: option.title, rationale: selection.rationale?.trim() || option.tradeoffs });
      } else {
        register.deferredItems.push({
          requirement: item.question,
          reason: selection.reason.trim(),
          suggestedNextStep: selection.suggestedNextStep?.trim() || '后续以新的需求来源创建独立任务',
        });
      }
    }
    register.pendingDecisions = [];
    const parsed = DecisionRegisterSchema.parse(register);
    await this.deps.taskStore.replaceFact(taskId, 'artifacts/requirement-analysis/decision-register.yaml', stringify(parsed));
    return parsed;
  }
}
