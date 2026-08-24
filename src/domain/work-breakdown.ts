import { z } from 'zod';

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
}).strict();

export const DevelopmentPlanSchema = z.object({
  schemaVersion: z.literal('aiw.development-plan/v1'),
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
  schemaVersion: z.literal('aiw.development-unit/v1'),
}).strict();

export type DevelopmentUnit = z.infer<typeof DevelopmentUnitSchema>;
export type DevelopmentPlan = z.infer<typeof DevelopmentPlanSchema>;
export type DevelopmentUnitContext = z.infer<typeof DevelopmentUnitContextSchema>;
