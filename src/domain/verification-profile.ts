import { z } from 'zod';

import { AcceptanceEvidenceTypeSchema } from './acceptance-evidence.js';

const profileIdPattern = /^[a-z][a-z0-9-]{0,40}$/;
const targetPathPattern = /^[A-Za-z0-9_./:@+=,-]+$/;

export const VerificationProfileRefSchema = z.object({
  profile: z.string().regex(profileIdPattern, '测试能力 ID 格式无效'),
  targets: z.array(z.string().regex(targetPathPattern, '测试目标只能使用仓库内的安全相对路径或标识')).default([]),
  evidenceType: AcceptanceEvidenceTypeSchema,
  acceptanceRefs: z.array(z.string().regex(/^AC-\d{2,}$/)).min(1),
}).strict();

export type VerificationProfileRef = z.infer<typeof VerificationProfileRefSchema>;
