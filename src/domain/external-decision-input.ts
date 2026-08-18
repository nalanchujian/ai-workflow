import { z } from 'zod';

export const ExternalDecisionInputSchema = z.object({
  schemaVersion: z.literal('aiw.external-decision-input/v1'),
  decisionId: z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效'),
  decisionRevision: z.number().int().positive(),
  summary: z.string().min(16, '新增事实至少需要 16 个字符'),
  evidence: z.string().min(1).optional(),
  recordedBy: z.string().min(1),
  recordedAt: z.string().datetime(),
}).strict();

export type ExternalDecisionInput = z.infer<typeof ExternalDecisionInputSchema>;
