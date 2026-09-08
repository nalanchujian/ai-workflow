import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

import { DesignAssetsSchema } from '../domain/design.js';
import { ApiAnalysisSchema } from '../domain/api-analysis.js';
import {
  DevelopmentPlanSchema,
  DevelopmentUnitContextSchema,
  validatePlanReferences,
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

export async function materializeDevelopmentWork(task: Task, taskStore: TaskStore): Promise<{ task: Task }> {
  const plan = await readDevelopmentPlan(task, taskStore);
  const readArtifact = async (path: string): Promise<unknown> => parse(await readFile(join(taskStore.taskDirectory(task.id), path), 'utf8'));
  const design = plan.units.some((unit) => unit.designReferences.length > 0)
    ? DesignAssetsSchema.parse(await readArtifact('artifacts/design/design-assets.yaml')) : undefined;
  const api = plan.units.some((unit) => unit.apiReferences.length > 0)
    ? ApiAnalysisSchema.parse(await readArtifact('artifacts/api-analysis/api-analysis.yaml')) : undefined;
  validatePlanReferences(plan, { api, design });
  const next = TaskSchema.parse(task);
  for (const [nodeId, node] of Object.entries(next.nodes)) {
    if (node.generatedFromPlan === true) delete next.nodes[nodeId];
  }

  for (const unit of plan.units) {
    const nodeId = unit.name;
    const contextPath = `artifacts/plan/units/${nodeId}.yaml`;
    const outputPath = `artifacts/development/${nodeId}/result.md`;
    const context = DevelopmentUnitContextSchema.parse({
      schemaVersion: 'aiw.development-unit/v2', ...unit,
      designReferences: unit.designReferences.map((reference) => ({ ...reference, imagePath: design!.assets.find((asset) => asset.id === reference.assetId)!.imagePath })),
      apiReferences: unit.apiReferences.map((reference) => {
        const document = api!.documents.find((entry) => entry.interfaces.some((api) => api.id === reference.apiId))!;
        return { ...reference, documentId: document.id, snapshotPath: document.snapshotPath };
      }),
    });
    await taskStore.replaceFact(task.id, contextPath, stringify(context, { lineWidth: 0 }));
    const dependencies = unit.dependencies.length === 0
      ? ['plan']
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
    skills: task.developmentSkills,
    requiresApproval: false,
    status: dependencies.every((dependency) => task.nodes[dependency]?.status === 'completed') ? 'ready' : 'pending',
    hasResult: false,
    outputs: [outputPath],
    contextPath,
    generatedFromPlan: true,
  };
}

export { DevelopmentPlanSchema, type DevelopmentPlan } from '../domain/work-breakdown.js';
