import { z } from 'zod';

const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

export const DevelopmentUnitSchema = z.object({
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
  const titles = new Set(plan.units.map((unit) => unit.title));
  if (titles.size !== plan.units.length) {
    context.addIssue({ code: 'custom', path: ['units'], message: '开发单元标题必须唯一' });
  }
  for (const [index, unit] of plan.units.entries()) {
    for (const dependency of unit.dependencies) {
      if (!titles.has(dependency)) {
        context.addIssue({ code: 'custom', path: ['units', index, 'dependencies'], message: `引用了未知开发单元：${dependency}` });
      } else if (dependency === unit.title) {
        context.addIssue({ code: 'custom', path: ['units', index, 'dependencies'], message: '开发单元不能依赖自身' });
      }
    }
  }

  const dependencies = new Map(plan.units.map((unit) => [unit.title, unit.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (title: string): boolean => {
    if (visiting.has(title)) return true;
    if (visited.has(title)) return false;
    visiting.add(title);
    for (const dependency of dependencies.get(title) ?? []) {
      if (dependencies.has(dependency) && hasCycle(dependency)) return true;
    }
    visiting.delete(title);
    visited.add(title);
    return false;
  };
  if (plan.units.some((unit) => hasCycle(unit.title))) {
    context.addIssue({ code: 'custom', path: ['units'], message: '开发单元依赖不能形成循环' });
  }
});

export const DevelopmentUnitContextSchema = DevelopmentUnitSchema.extend({
  schemaVersion: z.literal('aiw.development-unit/v1'),
}).strict();

export type DevelopmentUnit = z.infer<typeof DevelopmentUnitSchema>;
export type DevelopmentPlan = z.infer<typeof DevelopmentPlanSchema>;
export type DevelopmentUnitContext = z.infer<typeof DevelopmentUnitContextSchema>;
