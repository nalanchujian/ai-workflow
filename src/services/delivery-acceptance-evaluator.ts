import { parse, stringify } from 'yaml';

import { AcceptanceIntentSchema, type AcceptanceIntent } from '../domain/acceptance-intent.js';
import { AcceptanceResultsSchema, type AcceptanceResults } from '../domain/acceptance-results.js';
import type { TestResults } from '../domain/test-results.js';

/** The platform is the only authority allowed to turn test records into AC outcomes. */
export function evaluateDeliveryAcceptance(input: {
  intent: AcceptanceIntent;
  tests: TestResults;
  acceptanceRefs: string[];
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
    const records = item.testPlanRefs.map((id) => tests.get(id));
    const unknownTest = item.testPlanRefs.find((id, index) => records[index] === undefined);
    if (unknownTest !== undefined) {
      throw new Error(`验收项 ${item.id} 引用了本次计划外的测试：${unknownTest}`);
    }
    const status = records.every((record) => record?.status === 'passed' && record.exitCode === 0)
      ? 'passed'
      : records.some((record) => record?.status === 'blocked' || record?.status === 'skipped')
        ? 'blocked'
        : 'failed';
    return {
      id: item.id,
      status,
      evidence: item.evidence,
      testResultRefs: item.testPlanRefs,
    };
  });
  return AcceptanceResultsSchema.parse({ schemaVersion: 'aiw.acceptance-results/v1', items });
}

export function parseAcceptanceIntent(content: string): AcceptanceIntent {
  return AcceptanceIntentSchema.parse(parse(content));
}

export function serializeAcceptanceResults(results: AcceptanceResults): string {
  return stringify(results);
}
