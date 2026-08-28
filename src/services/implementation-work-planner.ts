import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

import type { DesignAssets } from '../domain/design.js';
import {
  DevelopmentPlanSchema,
  DevelopmentUnitContextSchema,
  type DevelopmentPlan,
} from '../domain/work-breakdown.js';
import { TaskSchema, type Task, type TaskNode } from '../domain/task.js';
import { formatSchemaDiagnostics } from '../domain/schema-diagnostics.js';
import { TaskStore } from './task-store.js';
import { deriveTaskStatus } from './task-state-machine.js';

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
    return parseDevelopmentPlan(content);
  } catch (error) {
    if (error instanceof DevelopmentPlanError) throw error;
    const detail = error instanceof Error ? `：${error.message}` : '';
    throw new DevelopmentPlanError(`无法读取开发计划 ${path}${detail}`);
  }
}

export function validateDevelopmentPlan(content: string): void {
  parseDevelopmentPlan(content);
}

function parseDevelopmentPlan(content: string): DevelopmentPlan {
  let data: unknown;
  try {
    data = parse(content);
    return DevelopmentPlanSchema.parse(data);
  } catch (error) {
    throw new DevelopmentPlanError(formatSchemaDiagnostics({ title: '开发计划', error, data, itemLabel: '开发单元' }));
  }
}

export async function applyDesignBindings(task: Task, taskStore: TaskStore, design: DesignAssets): Promise<void> {
  const developmentNodes = new Map(Object.entries(task.nodes).filter(([, node]) => node.generatedFromPlan === true));
  for (const asset of design.assets) {
    for (const unitName of asset.developmentUnits) {
      if (!developmentNodes.has(unitName)) {
        throw new DevelopmentPlanError(`设计截图 ${asset.id} 引用了未知开发单元：${unitName}`);
      }
    }
  }
  for (const [unitName, node] of developmentNodes) {
    if (node.contextPath === undefined) throw new DevelopmentPlanError(`开发单元缺少上下文：${unitName}`);
    const context = DevelopmentUnitContextSchema.parse(parse(await readFile(join(taskStore.taskDirectory(task.id), node.contextPath), 'utf8')));
    const designReferences = design.assets
      .filter((asset) => asset.developmentUnits.includes(unitName))
      .map((asset) => ({ assetId: asset.id, imagePath: asset.imagePath, purpose: asset.purpose }));
    await taskStore.replaceFact(task.id, node.contextPath, stringify({ ...context, designReferences }, { lineWidth: 0 }));
  }
}

export async function materializeDevelopmentWork(task: Task, taskStore: TaskStore): Promise<{ task: Task }> {
  const plan = await readDevelopmentPlan(task, taskStore);
  const next = TaskSchema.parse(task);
  for (const [nodeId, node] of Object.entries(next.nodes)) {
    if (node.generatedFromPlan === true) delete next.nodes[nodeId];
  }

  for (const unit of plan.units) {
    const nodeId = unit.name;
    const contextPath = `artifacts/plan/units/${nodeId}.yaml`;
    const outputPath = `artifacts/development/${nodeId}/result.md`;
    const context = DevelopmentUnitContextSchema.parse({ schemaVersion: 'aiw.development-unit/v1', ...unit, designReferences: [] });
    await taskStore.replaceFact(task.id, contextPath, stringify(context, { lineWidth: 0 }));
    const dependencies = unit.dependencies.length === 0
      ? [task.designInput === undefined ? 'plan' : 'design-analysis']
      : unit.dependencies;
    next.nodes[nodeId] = developmentNode(next, unit.title, contextPath, outputPath, dependencies);
  }
  next.events.push({ type: 'materialize_development', nodeId: 'plan', at: new Date().toISOString(), note: `已生成 ${plan.units.length} 个开发单元` });
  return { task: TaskSchema.parse(deriveTaskStatus(next)) };
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
