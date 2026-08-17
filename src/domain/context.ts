import { z } from 'zod';

import { SkillLockSchema, WorkflowProfileLockSchema } from './task.js';

const sha256Pattern = /^[a-f0-9]{64}$/;
const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

export const ContextBudgetCategorySchema = z.enum([
  'task-fact',
  'source',
  'handoff',
  'revision-request',
  'additional',
  'node-instruction',
  'skill',
  'method-source',
  'runtime-overhead',
]);

export type ContextBudgetCategory = z.infer<typeof ContextBudgetCategorySchema>;

export const ContextBudgetEntrySchema = z.object({
  category: ContextBudgetCategorySchema,
  label: z.string().min(1),
  estimatedTokens: z.number().int().nonnegative(),
});

export const ContextFileSchema = z.object({
  role: z.enum(['task', 'source', 'artifact', 'handoff', 'revision-request', 'additional']),
  path: z.string().regex(relativePathPattern),
  sha256: z.string().regex(sha256Pattern),
  sourceId: z.string().min(1).optional(),
  sourceRevision: z.number().int().positive().optional(),
});

export const ContextManifestSchema = z.object({
  schemaVersion: z.literal('aiw.context/v1'),
  taskId: z.string().min(1),
  nodeId: z.string().min(1),
  nodeRevision: z.number().int().nonnegative(),
  skillProfile: WorkflowProfileLockSchema,
  files: z.array(ContextFileSchema).min(1),
  skill: SkillLockSchema,
  budget: z.object({
    maxTokens: z.number().int().positive(),
    estimatedTokens: z.number().int().nonnegative(),
    breakdown: z.array(ContextBudgetEntrySchema).min(1),
  }),
});

export type ContextFile = z.infer<typeof ContextFileSchema>;
export type ContextManifest = z.infer<typeof ContextManifestSchema>;
