import { parse, stringify } from 'yaml';

import { AcceptanceIntentSchema, type AcceptanceIntent } from '../domain/acceptance-intent.js';
import { AcceptanceResultsSchema, type AcceptanceResults } from '../domain/acceptance-results.js';
import type { TestResults } from '../domain/test-results.js';
import type { VerificationPlanItem } from '../domain/acceptance-evidence.js';

/** The platform is the only authority allowed to turn test records into AC outcomes. */
export function evaluateDeliveryAcceptance(input: {
  intent: AcceptanceIntent;
  tests: TestResults;
  acceptanceRefs: string[];
  verificationPlan: VerificationPlanItem[];
}): AcceptanceResults {
  const intentIds = new Set(input.intent.items.map((item) => item.id));
  const expectedIds = new Set(input.acceptanceRefs);
  const missing = input.acceptanceRefs.filter((id) => !intentIds.has(id));
  const unknown = [...intentIds].filter((id) => !expectedIds.has(id));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`交付单元验收意图必须与其所属验收项逐项一一对应：${[
      ...(missing.length === 0 ? [] : [`缺少意图：${missing.join('、')}`]),
      ...(unknown.length === 0 ? [] : [`不存在的验收项：${unknown.join('、')}`]),
    ].join('；')}。`);
  }
  const tests = new Map(input.tests.items.map((item) => [item.id, item]));
  const items = input.intent.items.map((item) => {
    const approved = input.verificationPlan.filter((test) => test.acceptanceRefs.includes(item.id));
    if (approved.length === 0) throw new Error(`验收项 ${item.id} 没有已批准的测试映射`);
    const records = approved.map((plan) => tests.get(plan.id));
    const unknownTest = approved.find((plan, index) => records[index] === undefined);
    if (unknownTest !== undefined) {
      throw new Error(`验收项 ${item.id} 缺少已批准测试记录：${unknownTest.id}`);
    }
    for (const [index, plan] of approved.entries()) {
      const record = records[index]!;
      if (record.command !== plan.command || record.profile !== plan.profile || record.evidenceType !== plan.evidenceType ||
        record.acceptanceRefs.length !== plan.acceptanceRefs.length || record.acceptanceRefs.some((id) => !plan.acceptanceRefs.includes(id))) {
        throw new Error(`验收项 ${item.id} 的测试 ${plan.id} 证据类型与已批准计划不一致`);
      }
    }
    const status = records.every((record) => record?.status === 'passed' && record.exitCode === 0)
      ? 'passed'
      : records.some((record) => record?.status === 'blocked' || record?.status === 'skipped')
        ? 'blocked'
        : 'failed';
    return {
      id: item.id,
      status,
      evidenceType: approved[0]!.evidenceType,
      evidence: item.evidence,
      testResultRefs: approved.map((plan) => plan.id),
    };
  });
  return AcceptanceResultsSchema.parse({ schemaVersion: 'aiw.acceptance-results/v2', items });
}

export function parseAcceptanceIntent(content: string): AcceptanceIntent {
  return AcceptanceIntentSchema.parse(parse(content));
}

export function serializeAcceptanceResults(results: AcceptanceResults): string {
  return stringify(results);
}
