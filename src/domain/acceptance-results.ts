import { z } from 'zod';

import type { DeliveryStatus } from './task.js';

export const AcceptanceResultStatusSchema = z.enum(['passed', 'failed', 'blocked', 'deferred', 'waived']);

export const AcceptanceResultsSchema = z.object({
  schemaVersion: z.literal('aiw.acceptance-results/v1'),
  items: z.array(z.object({
    id: z.string().min(1),
    status: AcceptanceResultStatusSchema,
    evidence: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
}).strict().superRefine((results, context) => {
  const ids = new Set(results.items.map((item) => item.id));
  if (ids.size !== results.items.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: '验收项 ID 必须唯一' });
  }
});

export type AcceptanceResults = z.infer<typeof AcceptanceResultsSchema>;

export function deliveryStatusFromAcceptanceResults(results: AcceptanceResults): DeliveryStatus {
  return results.items.every((item) => ['passed', 'deferred', 'waived'].includes(item.status)) ? 'ready' : 'not_ready';
}
