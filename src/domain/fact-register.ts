import { z } from 'zod';

const factIdPattern = /^FACT-[A-Z0-9-]+$/;
const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

/**
 * A fact keeps the same identity everywhere it is referenced: the formal
 * clarification register, acceptance/decision links, and node handoffs.
 */
export const FactIdSchema = z.string().regex(factIdPattern, '事实 ID 格式无效');

/**
 * Facts are the explicit boundary between an input document and later
 * engineering work.  They deliberately distinguish what is known from what
 * is merely inferred or still depends on somebody outside the task.
 */
export const FactKindSchema = z.enum([
  'confirmed',
  'inferred',
  'unresolved',
  'external_dependency',
]);

export const FactConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const FactEvidenceSchema = z.object({
  sourceId: z.string().min(1),
  path: z.string().regex(relativePathPattern, '事实证据必须是任务目录内的相对路径'),
  locator: z.string().min(1).optional(),
}).strict();

export const FactItemSchema = z.object({
  id: FactIdSchema,
  kind: FactKindSchema,
  statement: z.string().min(12),
  confidence: FactConfidenceSchema,
  evidence: z.array(FactEvidenceSchema).min(1),
}).strict().superRefine((fact, context) => {
  if (fact.kind === 'confirmed' && fact.confidence !== 'high') {
    context.addIssue({ code: 'custom', path: ['confidence'], message: '已确认事实必须使用 high 可信度' });
  }
  if (fact.kind !== 'confirmed' && fact.confidence === 'high') {
    context.addIssue({ code: 'custom', path: ['confidence'], message: '推断、待确认或外部依赖不得标记为 high 可信度' });
  }
});

export const FactRegisterSchema = z.object({
  schemaVersion: z.literal('aiw.fact-register/v1'),
  items: z.array(FactItemSchema).min(1),
}).strict().superRefine((register, context) => {
  const ids = new Set(register.items.map((item) => item.id));
  if (ids.size !== register.items.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: '事实 ID 必须唯一' });
  }
});

export type FactKind = z.infer<typeof FactKindSchema>;
export type FactRegister = z.infer<typeof FactRegisterSchema>;
export type FactItem = z.infer<typeof FactItemSchema>;

export function factById(register: FactRegister): Map<string, FactItem> {
  return new Map(register.items.map((item) => [item.id, item]));
}
