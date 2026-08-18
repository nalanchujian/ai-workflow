import { z } from 'zod';

import { OutputRecordSchema } from './task.js';
import { ContextManifestSchema } from './context.js';

export const RunModeSchema = z.enum(['dry-run', 'execute']);
export const RunStatusSchema = z.enum(['succeeded', 'failed', 'unavailable', 'cancelled']);

const RunContextFileSchema = z.object({
  role: z.enum(['task', 'source', 'artifact', 'handoff', 'additional']),
  path: z.string().min(1),
  content: z.string(),
});

export const RunRequestSchema = z.object({
  schemaVersion: z.literal('aiw.run/v2'),
  runId: z.string().min(1),
  task: z.object({
    id: z.string().min(1),
    nodeId: z.string().min(1),
    phase: z.enum(['clarify', 'solution', 'plan', 'implement']),
    nodeRevision: z.number().int().nonnegative(),
    projectRoot: z.string().min(1),
  }),
  instruction: z.string().min(1),
  contextManifestPath: z.string().min(1),
  runDirectory: z.string().min(1),
  mode: RunModeSchema,
  artifacts: z.array(z.string().min(1)),
  context: z.object({
    skill: z.object({ name: z.string().min(1), version: z.string().min(1), content: z.string().min(1) }),
    methodSources: z.array(z.object({ id: z.string().min(1), content: z.string().min(1) })),
    files: z.array(RunContextFileSchema),
  }),
});

export const RunResultSchema = z.object({
  schemaVersion: z.literal('aiw.run-result/v1'),
  runId: z.string().min(1),
  status: RunStatusSchema,
  runDirectory: z.string().min(1),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  process: z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable() }).optional(),
  contextManifest: ContextManifestSchema.optional(),
  artifacts: z.array(OutputRecordSchema),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional(),
});

export type RunMode = z.infer<typeof RunModeSchema>;
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type RunResult = z.infer<typeof RunResultSchema>;
