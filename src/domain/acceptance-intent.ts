import { z } from 'zod';

import { TestResultIdSchema } from './test-results.js';

/**
 * Codex may explain which real test records should support an acceptance item,
 * but it must never decide the final pass/fail status.  That status is derived
 * by AIW after those tests have actually run.
 */
export const AcceptanceIntentSchema = z.object({
  schemaVersion: z.literal('aiw.acceptance-intent/v1'),
  items: z.array(z.object({
    id: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1),
    testPlanRefs: z.array(TestResultIdSchema).min(1),
  }).strict()).min(1),
}).strict().superRefine((intent, context) => {
  const ids = new Set(intent.items.map((item) => item.id));
  if (ids.size !== intent.items.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: '验收项 ID 必须唯一' });
  }
  for (const [index, item] of intent.items.entries()) {
    if (new Set(item.testPlanRefs).size !== item.testPlanRefs.length) {
      context.addIssue({ code: 'custom', path: ['items', index, 'testPlanRefs'], message: '每个验收项引用的测试 ID 必须唯一' });
    }
  }
});

export type AcceptanceIntent = z.infer<typeof AcceptanceIntentSchema>;
