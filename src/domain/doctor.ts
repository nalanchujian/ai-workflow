import { z } from 'zod';

export const DoctorCheckStatusSchema = z.enum(['passed', 'warning', 'failed']);

export const DoctorCheckSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: DoctorCheckStatusSchema,
  message: z.string().min(1),
  suggestion: z.string().min(1).optional(),
});

export const DoctorResultSchema = z.object({
  schemaVersion: z.literal('aiw.doctor/v1'),
  ok: z.boolean(),
  checks: z.array(DoctorCheckSchema).min(1),
});

export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;
export type DoctorResult = z.infer<typeof DoctorResultSchema>;
