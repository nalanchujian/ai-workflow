import { z } from 'zod';

export const ApprovalFactSchema = z.object({
  nodeId: z.string().min(1),
  artifactHashes: z.record(z.string(), z.string().regex(/^sha256:[a-f0-9]{64}$/)),
  decision: z.literal('approved'),
  actor: z.string().min(1),
  at: z.string().datetime(),
  note: z.string().optional(),
}).strict();

export type ApprovalFact = z.infer<typeof ApprovalFactSchema>;
