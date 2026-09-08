import { z } from 'zod';

import { DesignAssetsSchema, DesignReferenceSchema, ResolvedDesignReferenceSchema } from './design.js';
import { ApiAnalysisSchema, ApiReferenceSchema, ResolvedApiReferenceSchema } from './api-analysis.js';

const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;
const developmentUnitNamePattern = /^development-unit-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const DevelopmentUnitSchema = z.object({
  name: z.string().regex(
    developmentUnitNamePattern,
    '开发单元名称必须使用 development-unit-<英文 kebab-case 描述>，例如 development-unit-main-list-export',
  ),
  title: z.string().min(1),
  goal: z.string().min(1),
  requirements: z.array(z.string().min(1)).min(1),
  codeScope: z.array(z.string().regex(relativePathPattern, '代码范围必须是项目内相对路径')).min(1),
  steps: z.array(z.string().min(1)).min(1),
  dependencies: z.array(z.string().min(1)).default([]),
  apiReferences: z.array(ApiReferenceSchema).default([]),
  designReferences: z.array(DesignReferenceSchema).default([]),
}).strict();

export const DevelopmentPlanSchema = z.object({
  schemaVersion: z.literal('aiw.development-plan/v2'),
  units: z.array(DevelopmentUnitSchema).min(1),
}).strict().superRefine((plan, context) => {
  const names = new Set(plan.units.map((unit) => unit.name));
  if (names.size !== plan.units.length) {
    context.addIssue({ code: 'custom', path: ['units'], message: '开发单元名称必须唯一' });
  }
  const titles = new Set(plan.units.map((unit) => unit.title));
  if (titles.size !== plan.units.length) {
    context.addIssue({ code: 'custom', path: ['units'], message: '开发单元标题必须唯一' });
  }
  for (const [index, unit] of plan.units.entries()) {
    for (const [field, ids] of [
      ['apiReferences', unit.apiReferences.map((reference) => reference.apiId)],
      ['designReferences', unit.designReferences.map((reference) => reference.assetId)],
      ['dependencies', unit.dependencies],
    ] as const) {
      if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['units', index, field], message: '单元引用不能重复' });
    }
    for (const dependency of unit.dependencies) {
      if (!names.has(dependency)) {
        context.addIssue({ code: 'custom', path: ['units', index, 'dependencies'], message: `引用了未知开发单元名称：${dependency}` });
      } else if (dependency === unit.name) {
        context.addIssue({ code: 'custom', path: ['units', index, 'dependencies'], message: '开发单元不能依赖自身' });
      }
    }
  }

  const dependencies = new Map(plan.units.map((unit) => [unit.name, unit.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (name: string): boolean => {
    if (visiting.has(name)) return true;
    if (visited.has(name)) return false;
    visiting.add(name);
    for (const dependency of dependencies.get(name) ?? []) {
      if (dependencies.has(dependency) && hasCycle(dependency)) return true;
    }
    visiting.delete(name);
    visited.add(name);
    return false;
  };
  if (plan.units.some((unit) => hasCycle(unit.name))) {
    context.addIssue({ code: 'custom', path: ['units'], message: '开发单元依赖不能形成循环' });
  }
});

export const DevelopmentUnitContextSchema = DevelopmentUnitSchema.extend({
  schemaVersion: z.literal('aiw.development-unit/v2'),
  apiReferences: z.array(ResolvedApiReferenceSchema).default([]),
  designReferences: z.array(ResolvedDesignReferenceSchema).default([]),
}).strict();

/** Cross-artifact validation is shared by planning and runtime consumers. No I/O. */
export function validatePlanReferences(input: unknown, artifacts: { api?: unknown; design?: unknown } = {}): DevelopmentPlan {
  const plan = DevelopmentPlanSchema.parse(input);
  const api = artifacts.api === undefined ? undefined : ApiAnalysisSchema.parse(artifacts.api);
  const design = artifacts.design === undefined ? undefined : DesignAssetsSchema.parse(artifacts.design);
  const apiIds = new Set(api?.documents.flatMap((document) => document.interfaces.map((entry) => entry.id)) ?? []);
  const assetIds = new Set(design?.assets.map((asset) => asset.id) ?? []);
  plan.units.forEach((unit) => {
    for (const reference of unit.apiReferences) {
      if (!apiIds.has(reference.apiId)) throw new Error(`开发单元 ${unit.name} 引用了未知接口：${reference.apiId}`);
    }
    for (const reference of unit.designReferences) {
      if (!assetIds.has(reference.assetId)) throw new Error(`开发单元 ${unit.name} 引用了未知图片：${reference.assetId}`);
    }
  });
  return plan;
}

export type DevelopmentUnit = z.infer<typeof DevelopmentUnitSchema>;
export type DevelopmentPlan = z.infer<typeof DevelopmentPlanSchema>;
export type DevelopmentUnitContext = z.infer<typeof DevelopmentUnitContextSchema>;
