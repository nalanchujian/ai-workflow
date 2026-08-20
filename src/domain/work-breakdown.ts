import { z } from 'zod';

import { VerificationProfileRefSchema } from './verification-profile.js';

const unitIdPattern = /^[a-z][a-z0-9-]{0,40}$/;

const WorkUnitSchema = z.object({
  id: z.string().regex(unitIdPattern, '工作单元 ID 格式无效'),
  title: z.string().min(1),
  goal: z.string().min(1),
  acceptanceRefs: z.array(z.string().min(1)).min(1),
  factRefs: z.array(z.string().regex(/^FACT-[A-Z0-9-]+$/, '事实引用格式无效')).min(1),
  decisionRefs: z.array(z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效')).default([]),
  steps: z.array(z.string().min(1)).min(1),
  verification: z.array(VerificationProfileRefSchema).min(1),
  blockedBy: z.array(z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效')).default([]),
  dependsOn: z.array(z.string().regex(unitIdPattern, '依赖工作单元 ID 格式无效')).default([]),
}).strict();

const AcceptanceCoverageSchema = z.object({
  acceptanceId: z.string().regex(/^AC-\d{2,}$/, '验收项 ID 格式无效'),
  disposition: z.enum(['implement', 'waiting_external']),
  workUnitIds: z.array(z.string().regex(unitIdPattern, '工作单元 ID 格式无效')).default([]),
  decisionId: z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效').optional(),
}).strict();

export const WorkBreakdownSchema = z.object({
  schemaVersion: z.literal('aiw.work-breakdown/v2'),
  units: z.array(WorkUnitSchema).min(1),
  acceptanceCoverage: z.array(AcceptanceCoverageSchema).min(1),
}).strict().superRefine((breakdown, context) => {
  const ids = new Set(breakdown.units.map((unit) => unit.id));
  if (ids.size !== breakdown.units.length) {
    context.addIssue({ code: 'custom', path: ['units'], message: '工作单元 ID 必须唯一' });
  }
  for (const [index, unit] of breakdown.units.entries()) {
    for (const dependency of unit.dependsOn) {
      if (!ids.has(dependency) || dependency === unit.id) {
        context.addIssue({ code: 'custom', path: ['units', index, 'dependsOn'], message: '工作单元依赖必须指向其他已声明单元' });
      }
    }
    if (new Set(unit.factRefs).size !== unit.factRefs.length) {
      context.addIssue({ code: 'custom', path: ['units', index, 'factRefs'], message: '工作单元引用的事实 ID 必须唯一' });
    }
    if (new Set(unit.decisionRefs).size !== unit.decisionRefs.length) {
      context.addIssue({ code: 'custom', path: ['units', index, 'decisionRefs'], message: '工作单元引用的决策 ID 必须唯一' });
    }
    if (unit.blockedBy.some((id) => !unit.decisionRefs.includes(id))) {
      context.addIssue({ code: 'custom', path: ['units', index, 'decisionRefs'], message: 'blockedBy 中的决策必须同时出现在 decisionRefs' });
    }
    if (new Set(unit.verification.map((item) => `${item.profile}:${item.targets.join(',')}`)).size !== unit.verification.length) {
      context.addIssue({ code: 'custom', path: ['units', index, 'verification'], message: '工作单元测试能力引用不能重复' });
    }
    const verificationAcceptance = new Set(unit.verification.flatMap((item) => item.acceptanceRefs));
    const missingVerification = unit.acceptanceRefs.filter((id) => !verificationAcceptance.has(id));
    const unknownVerification = [...verificationAcceptance].filter((id) => !unit.acceptanceRefs.includes(id));
    if (missingVerification.length > 0 || unknownVerification.length > 0) {
      context.addIssue({ code: 'custom', path: ['units', index, 'verification'], message: '每个工作单元的验证映射必须且只能覆盖该单元的验收项' });
    }
  }
  if (hasCycle(breakdown.units.map((unit) => ({ id: unit.id, dependsOn: unit.dependsOn })))) {
    context.addIssue({ code: 'custom', path: ['units'], message: '工作单元依赖存在环' });
  }
  const coverageIds = new Set(breakdown.acceptanceCoverage.map((item) => item.acceptanceId));
  if (coverageIds.size !== breakdown.acceptanceCoverage.length) {
    context.addIssue({ code: 'custom', path: ['acceptanceCoverage'], message: '验收覆盖声明不能重复同一验收项' });
  }
  for (const [index, coverage] of breakdown.acceptanceCoverage.entries()) {
    const unitIds = new Set(coverage.workUnitIds);
    if (unitIds.size !== coverage.workUnitIds.length || coverage.workUnitIds.some((id) => !ids.has(id))) {
      context.addIssue({ code: 'custom', path: ['acceptanceCoverage', index, 'workUnitIds'], message: '验收覆盖必须引用已声明且唯一的工作单元' });
    }
    if (coverage.workUnitIds.length !== 1) {
      context.addIssue({ code: 'custom', path: ['acceptanceCoverage', index, 'workUnitIds'], message: '每个本期或外部等待验收项必须且只能关联一个交付单元；跨单元验收请新增集成交付单元' });
    }
    if (coverage.disposition === 'waiting_external' && coverage.decisionId === undefined) {
      context.addIssue({ code: 'custom', path: ['acceptanceCoverage', index], message: '等待外部条件验收项必须关联决策和一个交付单元' });
    }
  }
});

export type WorkBreakdown = z.infer<typeof WorkBreakdownSchema>;

function hasCycle(units: Array<{ id: string; dependsOn: string[] }>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const graph = new Map(units.map((unit) => [unit.id, unit.dependsOn]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return units.some((unit) => visit(unit.id));
}
