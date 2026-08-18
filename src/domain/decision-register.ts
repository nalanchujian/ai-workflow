import { z } from 'zod';

const decisionIdPattern = /^DEC-[A-Z0-9-]+$/;
const workUnitIdPattern = /^[a-z][a-z0-9-]{0,40}$/;

const DecisionOptionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, '决策选项 ID 格式无效'),
  title: z.string().min(1),
  tradeoffs: z.string().min(8),
}).strict();

export const DecisionItemSchema = z.object({
  id: z.string().regex(decisionIdPattern, '决策 ID 格式无效'),
  title: z.string().min(1),
  detail: z.object({
    question: z.string().min(8),
    background: z.string().min(16),
    impact: z.string().min(12),
  }).strict(),
  type: z.enum(['business-rule', 'technical-contract', 'external-contract', 'engineering-baseline']),
  factRefs: z.array(z.string().regex(/^FACT-[A-Z0-9-]+$/, '事实引用格式无效')).min(1),
  affects: z.object({
    acceptanceRefs: z.array(z.string().min(1)).length(1, '每个决策项只能关联一个验收项'),
    workUnits: z.array(z.string().regex(workUnitIdPattern, '工作单元 ID 格式无效')).min(1),
  }).strict(),
  options: z.array(DecisionOptionSchema)
    .min(1, '至少提供一个本期继续方案')
    .max(2, 'AI 可选方案最多两个'),
  recommendation: z.object({ optionId: z.string().min(1), rationale: z.string().min(8) }).strict(),
}).strict().superRefine((item, context) => {
  const optionIds = new Set(item.options.map((option) => option.id));
  if (optionIds.size !== item.options.length) {
    context.addIssue({ code: 'custom', path: ['options'], message: '决策选项 ID 必须唯一' });
  }
  if (!optionIds.has(item.recommendation.optionId)) {
    context.addIssue({ code: 'custom', path: ['recommendation', 'optionId'], message: '推荐方案必须引用已声明选项' });
  }
  if (new Set(item.factRefs).size !== item.factRefs.length) {
    context.addIssue({ code: 'custom', path: ['factRefs'], message: '决策引用的事实 ID 必须唯一' });
  }
});

export const DecisionRegisterSchema = z.object({
  schemaVersion: z.literal('aiw.decision-register/v1'),
  items: z.array(DecisionItemSchema),
}).strict().superRefine((register, context) => {
  const ids = new Set(register.items.map((item) => item.id));
  if (ids.size !== register.items.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: '决策 ID 必须唯一' });
  }
});

export type DecisionItem = z.infer<typeof DecisionItemSchema>;
export type DecisionRegister = z.infer<typeof DecisionRegisterSchema>;
