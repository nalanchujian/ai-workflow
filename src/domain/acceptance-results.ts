import { z } from 'zod';

import type { DeliveryStatus } from './task.js';
import { TestResultIdSchema } from './test-results.js';

export const AcceptanceResultStatusSchema = z.enum(['passed', 'failed', 'blocked', 'deferred', 'waived']);

export const AcceptanceResultsSchema = z.object({
  schemaVersion: z.literal('aiw.acceptance-results/v1'),
  items: z.array(z.object({
    id: z.string().min(1),
    status: AcceptanceResultStatusSchema,
    evidence: z.array(z.string().min(1)).min(1),
    testResultRefs: z.array(TestResultIdSchema),
  }).strict()).min(1),
}).strict().superRefine((results, context) => {
  const ids = new Set(results.items.map((item) => item.id));
  if (ids.size !== results.items.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: '验收项 ID 必须唯一' });
  }
  for (const [index, item] of results.items.entries()) {
    if (item.status === 'passed' && item.testResultRefs.length === 0) {
      context.addIssue({ code: 'custom', path: ['items', index, 'testResultRefs'], message: '通过的验收项必须引用至少一条实际通过的测试记录' });
    }
  }
});

export type AcceptanceResults = z.infer<typeof AcceptanceResultsSchema>;

export function deliveryStatusFromAcceptanceResults(results: AcceptanceResults): DeliveryStatus {
  return results.items.every((item) => ['passed', 'deferred', 'waived'].includes(item.status)) ? 'ready' : 'not_ready';
}
