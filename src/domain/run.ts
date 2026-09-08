import { z } from 'zod';

import { OutputRecordSchema, PhaseSchema } from './task.js';
import { ContextManifestSchema } from './context.js';
import { OutputContractSchema } from './output-contract.js';

export const RunModeSchema = z.enum(['dry-run', 'execute']);
export const RunStatusSchema = z.enum(['succeeded', 'failed', 'unavailable', 'cancelled']);

const RunContextFileSchema = z.object({
  role: z.enum(['source', 'artifact', 'generated', 'additional']),
  path: z.string().min(1),
  content: z.string(),
});

export const RunRequestSchema = z.object({
  schemaVersion: z.literal('aiw.run/v5'),
  runId: z.string().min(1),
  task: z.object({
    id: z.string().min(1),
    nodeId: z.string().min(1),
    phase: PhaseSchema,
    projectRoot: z.string().min(1),
  }),
  instruction: z.string().min(1),
  contextManifestPath: z.string().min(1),
  runDirectory: z.string().min(1),
  mode: RunModeSchema,
  artifacts: z.array(z.string().min(1)),
  outputContract: OutputContractSchema,
  context: z.object({
    skills: z.array(z.object({ name: z.string().min(1), version: z.string().min(1), content: z.string().min(1) })).min(1),
    files: z.array(RunContextFileSchema),
    images: z.array(z.object({ path: z.string().min(1), absolutePath: z.string().min(1) })).default([]),
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
