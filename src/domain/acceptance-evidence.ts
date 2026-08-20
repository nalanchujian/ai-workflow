import { z } from 'zod';

/** The kind of real-world observation required to prove an acceptance item. */
export const AcceptanceEvidenceTypeSchema = z.enum([
  'unit',
  'component',
  'browser',
  'contract',
  'integration',
]);

export const TestResultIdSchema = z.string().regex(/^TEST-[A-Z0-9-]+$/, '测试记录 ID 格式无效');

export const VerificationPlanItemSchema = z.object({
  id: TestResultIdSchema,
  profile: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, '测试能力 ID 格式无效'),
  evidenceType: AcceptanceEvidenceTypeSchema,
  acceptanceRefs: z.array(z.string().regex(/^AC-\d{2,}$/, '验收项 ID 格式无效')).min(1),
  command: z.string().min(1),
}).strict();

export type AcceptanceEvidenceType = z.infer<typeof AcceptanceEvidenceTypeSchema>;
export type VerificationPlanItem = z.infer<typeof VerificationPlanItemSchema>;
