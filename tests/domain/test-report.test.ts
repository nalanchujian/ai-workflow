import { describe, expect, it } from 'vitest';

import { hasTestPlanEvidence, validateAcceptanceTestEvidence } from '../../src/domain/test-report.js';

describe('hasTestPlanEvidence', () => {
  it('accepts a named test plan with an ID and executable command', () => {
    const report = '# 交付报告\n\n## 测试计划\n\nTEST-LIST-01：`pnpm test -- list`\n';

    expect(hasTestPlanEvidence(report)).toBe(true);
  });

  it('rejects a report that has a conclusion but no executable test evidence', () => {
    const report = '# 交付报告\n\n## 测试计划\n\n测试由 AIW 执行。\n';

    expect(hasTestPlanEvidence(report)).toBe(false);
  });

  it('binds a passed acceptance item to an actual passing test record', () => {
    const report = '# 交付报告\n\n## 测试计划\n\nTEST-LIST-01：`pnpm test -- list`\n';
    expect(() => validateAcceptanceTestEvidence({
      report,
      tests: { schemaVersion: 'aiw.test-results/v2', runId: 'run-1', items: [{ id: 'TEST-LIST-01', profile: 'vitest', evidenceType: 'unit', acceptanceRefs: ['AC-01'], command: 'pnpm test -- list', status: 'passed', exitCode: 0, summary: '列表测试已执行且全部通过。', evidencePath: 'runs/run-1/tests/TEST-LIST-01.json', evidenceSha256: 'a'.repeat(64) }] },
      acceptance: { schemaVersion: 'aiw.acceptance-results/v2', items: [{ id: 'AC-01', status: 'passed', evidenceType: 'unit', evidence: ['artifacts/delivery.md'], testResultRefs: ['TEST-LIST-01'] }] },
    })).not.toThrow();
  });

  it('rejects a passed acceptance item that points to a failed test record', () => {
    expect(() => validateAcceptanceTestEvidence({
      report: '# 交付报告\n\n## 测试计划\n\nTEST-LIST-01：`pnpm test -- list`\n',
      tests: { schemaVersion: 'aiw.test-results/v2', runId: 'run-1', items: [{ id: 'TEST-LIST-01', profile: 'vitest', evidenceType: 'unit', acceptanceRefs: ['AC-01'], command: 'pnpm test -- list', status: 'failed', exitCode: 1, summary: '列表测试已执行但存在失败用例。', evidencePath: 'runs/run-1/tests/TEST-LIST-01.json', evidenceSha256: 'a'.repeat(64) }] },
      acceptance: { schemaVersion: 'aiw.acceptance-results/v2', items: [{ id: 'AC-01', status: 'passed', evidenceType: 'unit', evidence: ['artifacts/delivery.md'], testResultRefs: ['TEST-LIST-01'] }] },
    })).toThrow('实际通过且退出码为 0');
  });
});
