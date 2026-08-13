import { z } from 'zod';

import { OutputRecordSchema } from './task.js';

const RunLogSchema = z.object({
  kind: z.enum(['context', 'stdout', 'stderr', 'last-message', 'request']),
  path: z.string().min(1),
  available: z.boolean(),
});

export const RunHistorySchema = z.object({
  schemaVersion: z.literal('aiw.run-history/v1'),
  taskId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'unavailable', 'cancelled']),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  artifacts: z.array(OutputRecordSchema),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional(),
  logs: z.array(RunLogSchema),
  context: z.object({
    manifestPath: z.string().min(1),
    nodeId: z.string().min(1),
    nodeRevision: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    roles: z.array(z.string().min(1)),
    estimatedTokens: z.number().int().nonnegative(),
    maxTokens: z.number().int().positive(),
  }),
});

const RunDirectorySchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  path: z.string().min(1),
  modifiedAt: z.string().datetime(),
});

export const RunPruneResultSchema = z.object({
  schemaVersion: z.literal('aiw.run-prune/v1'),
  apply: z.boolean(),
  olderThanDays: z.number().int().positive(),
  candidates: z.array(RunDirectorySchema),
  deleted: z.array(RunDirectorySchema),
});

export type RunHistory = z.infer<typeof RunHistorySchema>;
export type RunPruneResult = z.infer<typeof RunPruneResultSchema>;
