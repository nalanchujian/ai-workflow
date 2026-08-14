import { z } from 'zod';

const decisionIdPattern = /^DEC-[A-Z0-9-]+$/;
const workUnitIdPattern = /^[a-z][a-z0-9-]{0,40}$/;

const DecisionOptionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, '决策选项 ID 格式无效'),
  title: z.string().min(1),
  tradeoffs: z.string().min(8),
}).strict();

const ResolutionSchema = z.object({
  optionId: z.string().min(1),
  actor: z.string().min(1),
  at: z.string().datetime(),
  owner: z.string().min(1).optional(),
  unblockCondition: z.string().min(8).optional(),
  note: z.string().min(1).optional(),
}).strict();

export const DecisionItemSchema = z.object({
  id: z.string().regex(decisionIdPattern, '决策 ID 格式无效'),
  title: z.string().min(1),
  type: z.enum(['business-rule', 'technical-contract', 'external-contract', 'engineering-baseline']),
  affects: z.object({
    acceptanceRefs: z.array(z.string().min(1)).min(1),
    workUnits: z.array(z.string().regex(workUnitIdPattern, '工作单元 ID 格式无效')).min(1),
  }).strict(),
  status: z.enum(['proposed', 'resolved', 'waiting_external', 'deferred', 'waived']),
  options: z.array(DecisionOptionSchema).min(2, '至少两个选项才能形成可选择的决策'),
  recommendation: z.object({ optionId: z.string().min(1), rationale: z.string().min(8) }).strict(),
  resolution: ResolutionSchema.optional(),
}).strict().superRefine((item, context) => {
  const optionIds = new Set(item.options.map((option) => option.id));
  if (optionIds.size !== item.options.length) {
    context.addIssue({ code: 'custom', path: ['options'], message: '决策选项 ID 必须唯一' });
  }
  if (!optionIds.has(item.recommendation.optionId)) {
    context.addIssue({ code: 'custom', path: ['recommendation', 'optionId'], message: '推荐方案必须引用已声明选项' });
  }
  if (item.status === 'proposed' && item.resolution !== undefined) {
    context.addIssue({ code: 'custom', path: ['resolution'], message: '待决策事项不得包含人工选择' });
  }
  if (item.status !== 'proposed' && item.resolution === undefined) {
    context.addIssue({ code: 'custom', path: ['resolution'], message: '已选择、外部等待、拆期或豁免事项必须记录人工选择' });
  }
  if (item.resolution !== undefined && !optionIds.has(item.resolution.optionId)) {
    context.addIssue({ code: 'custom', path: ['resolution', 'optionId'], message: '人工选择必须引用已声明选项' });
  }
  if (item.status === 'waiting_external' && (item.resolution?.owner === undefined || item.resolution.unblockCondition === undefined)) {
    context.addIssue({ code: 'custom', path: ['resolution'], message: '外部等待事项必须记录责任人和解除条件' });
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

export function unresolvedBlockingDecisionIds(register: DecisionRegister, workUnitId: string): string[] {
  return register.items
    .filter((item) => item.affects.workUnits.includes(workUnitId))
    .filter((item) => item.status === 'proposed' || item.status === 'waiting_external')
    .map((item) => item.id);
}
