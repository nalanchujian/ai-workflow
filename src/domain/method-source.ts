import { z } from 'zod';

export const MethodSourceSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});

export const ResolvedMethodSourceSchema = MethodSourceSchema.extend({
  revision: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type MethodSource = z.infer<typeof MethodSourceSchema>;
export type ResolvedMethodSource = z.infer<typeof ResolvedMethodSourceSchema>;
