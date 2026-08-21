import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

import {
  DevelopmentPlanSchema,
  DevelopmentUnitContextSchema,
  type DevelopmentPlan,
} from '../domain/work-breakdown.js';
import { TaskSchema, type Task, type TaskNode } from '../domain/task.js';
import { formatSchemaDiagnostics } from '../domain/schema-diagnostics.js';
import { TaskStore } from './task-store.js';

export class DevelopmentPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevelopmentPlanError';
  }
}

export async function readDevelopmentPlan(task: Task, taskStore: TaskStore): Promise<DevelopmentPlan> {
  const path = 'artifacts/plan/development-plan.yaml';
  try {
    const content = await readFile(join(taskStore.taskDirectory(task.id), path), 'utf8');
    return DevelopmentPlanSchema.parse(parse(content));
  } catch (error) {
    if (error instanceof DevelopmentPlanError) throw error;
    const detail = error instanceof Error ? `：${error.message}` : '';
    throw new DevelopmentPlanError(`无法读取开发计划 ${path}${detail}`);
  }
}

export function validateDevelopmentPlan(content: string): void {
  try {
    DevelopmentPlanSchema.parse(parse(content));
  } catch (error) {
    throw new DevelopmentPlanError(formatSchemaDiagnostics({ title: '开发计划', error, itemLabel: '开发单元' }));
  }
}

export async function materializeDevelopmentWork(task: Task, taskStore: TaskStore): Promise<{ task: Task }> {
  const plan = await readDevelopmentPlan(task, taskStore);
  const next = TaskSchema.parse(task);
  for (const [nodeId, node] of Object.entries(next.nodes)) {
    if (node.generatedFromPlan === true) delete next.nodes[nodeId];
  }

  const nodeIdsByTitle = new Map(plan.units.map((unit, index) => [unit.title, `development-unit-${index + 1}`]));
  for (const [index, unit] of plan.units.entries()) {
    const nodeId = `development-unit-${index + 1}`;
    const contextPath = `artifacts/plan/units/${nodeId}.yaml`;
    const outputPath = `artifacts/development/${nodeId}/result.md`;
    const context = DevelopmentUnitContextSchema.parse({ schemaVersion: 'aiw.development-unit/v1', ...unit });
    await taskStore.replaceFact(task.id, contextPath, stringify(context, { lineWidth: 0 }));
    const dependencies = unit.dependencies.length === 0
      ? ['plan']
      : unit.dependencies.map((title) => nodeIdsByTitle.get(title)!);
    next.nodes[nodeId] = developmentNode(next, unit.title, contextPath, outputPath, dependencies);
  }
  next.events.push({ type: 'materialize_development', nodeId: 'plan', at: new Date().toISOString(), note: `已生成 ${plan.units.length} 个开发单元` });
  return { task: TaskSchema.parse(next) };
}

function developmentNode(task: Task, title: string, contextPath: string, outputPath: string, dependencies: string[]): TaskNode {
  return {
    title,
    phase: 'development',
    dependsOn: dependencies,
    skill: task.developmentSkill,
    requiresApproval: false,
    status: dependencies.every((dependency) => task.nodes[dependency]?.status === 'completed') ? 'ready' : 'pending',
    hasResult: false,
    outputs: [outputPath],
    contextPath,
    generatedFromPlan: true,
  };
}

export { DevelopmentPlanSchema, type DevelopmentPlan } from '../domain/work-breakdown.js';
