import { z } from 'zod';

import { SkillLockSchema, WorkflowProfileLockSchema } from './task.js';

export const DEFAULT_CONTEXT_TOKEN_BUDGET = 20_000;
const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

export const ContextBudgetCategorySchema = z.enum([
  'task-fact', 'source', 'generated', 'additional', 'node-instruction', 'skill', 'runtime-overhead',
]);
export type ContextBudgetCategory = z.infer<typeof ContextBudgetCategorySchema>;

export const ContextBudgetEntrySchema = z.object({
  category: ContextBudgetCategorySchema,
  label: z.string().min(1),
  estimatedTokens: z.number().int().nonnegative(),
}).strict();

export const ContextFileSchema = z.object({
  role: z.enum(['source', 'artifact', 'generated', 'additional']),
  path: z.string().regex(relativePathPattern),
}).strict();

export const ContextManifestSchema = z.object({
  schemaVersion: z.literal('aiw.context/v3'),
  taskId: z.string().min(1),
  nodeId: z.string().min(1),
  skillProfile: WorkflowProfileLockSchema,
  files: z.array(ContextFileSchema),
  images: z.array(z.object({ path: z.string().regex(relativePathPattern) }).strict()).default([]),
  skills: z.array(SkillLockSchema).min(1),
  budget: z.object({
    maxTokens: z.number().int().positive(),
    estimatedTokens: z.number().int().nonnegative(),
    breakdown: z.array(ContextBudgetEntrySchema),
  }).strict(),
}).strict();

export type ContextFile = z.infer<typeof ContextFileSchema>;
export type ContextManifest = z.infer<typeof ContextManifestSchema>;
