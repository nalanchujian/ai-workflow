import { z } from 'zod';

const DecisionOptionSchema = z.object({
  title: z.string().min(1),
  tradeoffs: z.string().min(1),
}).strict();

export const PendingDecisionSchema = z.object({
  question: z.string().min(1),
  background: z.string().min(1),
  impact: z.string().min(1),
  options: z.array(DecisionOptionSchema).min(1, '至少提供一个本期继续方案').max(2, 'AI 可选方案最多两个'),
  recommendation: z.object({
    option: z.number().int().nonnegative(),
    rationale: z.string().min(1),
  }).strict(),
}).strict().superRefine((decision, context) => {
  if (decision.recommendation.option >= decision.options.length) {
    context.addIssue({ code: 'custom', path: ['recommendation', 'option'], message: '推荐方案必须引用已声明选项' });
  }
});

export const CurrentDecisionSchema = z.object({
  question: z.string().min(1),
  selectedApproach: z.string().min(1),
  rationale: z.string().min(1),
}).strict();

export const DeferredItemSchema = z.object({
  requirement: z.string().min(1),
  reason: z.string().min(1),
  suggestedNextStep: z.string().min(1),
}).strict();

export const DecisionRegisterSchema = z.object({
  schemaVersion: z.literal('aiw.decision-register/v2'),
  pendingDecisions: z.array(PendingDecisionSchema),
  currentDecisions: z.array(CurrentDecisionSchema),
  deferredItems: z.array(DeferredItemSchema),
}).strict().superRefine((register, context) => {
  register.pendingDecisions.forEach((decision, index) => {
    if (decision.recommendation.option >= decision.options.length) {
      context.addIssue({ code: 'custom', path: ['pendingDecisions', index, 'recommendation', 'option'], message: 'AI 推荐必须指向现有方案' });
    }
  });
});

export type PendingDecision = z.infer<typeof PendingDecisionSchema>;
export type CurrentDecision = z.infer<typeof CurrentDecisionSchema>;
export type DeferredItem = z.infer<typeof DeferredItemSchema>;
export type DecisionRegister = z.infer<typeof DecisionRegisterSchema>;
