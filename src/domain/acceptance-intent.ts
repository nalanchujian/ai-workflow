import { z } from 'zod';

/**
 * Codex may explain the delivery evidence for an acceptance item, but it must
 * never choose tests or decide the final outcome. Both are fixed by the
 * approved plan and evaluated by AIW.
 */
export const AcceptanceIntentSchema = z.object({
  schemaVersion: z.literal('aiw.acceptance-intent/v2'),
  items: z.array(z.object({
    id: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
}).strict().superRefine((intent, context) => {
  const ids = new Set(intent.items.map((item) => item.id));
  if (ids.size !== intent.items.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: '验收项 ID 必须唯一' });
  }
});

export type AcceptanceIntent = z.infer<typeof AcceptanceIntentSchema>;
