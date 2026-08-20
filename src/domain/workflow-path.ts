import { z } from 'zod';

import { WorkflowPathIdSchema } from './task.js';

export const WORKFLOW_PATH_POLICY_VERSION = 'quick-standard/v1';
export const QUICK_SOURCE_CHARACTER_LIMIT = 12_000;

const WorkflowPathReasonSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
}).strict();

export const WorkflowPathAssessmentSchema = z.object({
  schemaVersion: z.literal('aiw.workflow-path-assessment/v1'),
  taskId: z.string().min(1),
  policyVersion: z.literal(WORKFLOW_PATH_POLICY_VERSION),
  recommendedPath: WorkflowPathIdSchema,
  signals: z.object({
    sourceCount: z.number().int().positive(),
    sourceCharacters: z.number().int().nonnegative(),
    acceptanceCount: z.number().int().nonnegative(),
    decisionCount: z.number().int().nonnegative(),
    confirmedFactCount: z.number().int().nonnegative(),
    nonConfirmedFactCount: z.number().int().nonnegative(),
  }).strict(),
  quick: z.object({
    eligible: z.boolean(),
    reasons: z.array(WorkflowPathReasonSchema),
  }).strict(),
  evaluatedAt: z.string().datetime(),
}).strict();

export type WorkflowPathAssessment = z.infer<typeof WorkflowPathAssessmentSchema>;

export function workflowPathLabel(path: z.infer<typeof WorkflowPathIdSchema>): string {
  return path === 'quick' ? '快速修改' : '标准需求';
}
