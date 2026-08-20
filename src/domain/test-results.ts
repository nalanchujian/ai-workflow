import { z } from 'zod';

import { AcceptanceEvidenceTypeSchema, TestResultIdSchema } from './acceptance-evidence.js';
export { TestResultIdSchema } from './acceptance-evidence.js';

const sha256Pattern = /^[a-f0-9]{64}$/;
const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

export const TestResultStatusSchema = z.enum(['passed', 'failed', 'blocked', 'skipped']);

export const TestResultsSchema = z.object({
  schemaVersion: z.literal('aiw.test-results/v2'),
  runId: z.string().min(1),
  items: z.array(z.object({
    id: TestResultIdSchema,
    profile: z.string().min(1),
    evidenceType: AcceptanceEvidenceTypeSchema,
    acceptanceRefs: z.array(z.string().regex(/^AC-\d{2,}$/)).min(1),
    command: z.string().min(1),
    status: TestResultStatusSchema,
    exitCode: z.number().int().min(0).nullable(),
    summary: z.string().min(8),
    evidencePath: z.string().regex(relativePathPattern, '测试证据必须是任务目录内的相对路径'),
    evidenceSha256: z.string().regex(sha256Pattern, '测试证据必须是 SHA-256 哈希'),
  }).strict()).min(1),
}).strict().superRefine((results, context) => {
  const ids = new Set(results.items.map((item) => item.id));
  if (ids.size !== results.items.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: '测试记录 ID 必须唯一' });
  }

  for (const [index, item] of results.items.entries()) {
    if (!item.evidencePath.startsWith(`runs/${results.runId}/tests/`)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'evidencePath'], message: '测试证据必须由当前运行写入 runs/<run-id>/tests/' });
    }
    if (item.status === 'passed' && item.exitCode !== 0) {
      context.addIssue({ code: 'custom', path: ['items', index, 'exitCode'], message: '通过的测试必须记录退出码 0' });
    }
    if (item.status === 'failed' && (item.exitCode === null || item.exitCode === 0)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'exitCode'], message: '失败的测试必须记录非 0 退出码' });
    }
    if (['blocked', 'skipped'].includes(item.status) && item.exitCode !== null) {
      context.addIssue({ code: 'custom', path: ['items', index, 'exitCode'], message: '阻塞或跳过的测试不得伪造退出码' });
    }
  }
});

export type TestResults = z.infer<typeof TestResultsSchema>;
