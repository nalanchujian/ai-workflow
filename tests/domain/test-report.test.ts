import { describe, expect, it } from 'vitest';

import { hasTestExecutionEvidence, validateAcceptanceTestEvidence } from '../../src/domain/test-report.js';

describe('hasTestExecutionEvidence', () => {
  it('accepts a structured check table that records a command and its exit code', () => {
    const report = `# 验收测试报告

## 工程检查

| 检查 | 结果 | 实际结果 |
| --- | --- | --- |
| \`npm run tsc\` | 失败 | 退出码 \`2\`。 |
`;

    expect(hasTestExecutionEvidence(report)).toBe(true);
  });

  it('rejects a report that has a conclusion but no executable test evidence', () => {
    const report = '# 验收测试报告\n\n## 结论\n\n测试未通过，需要继续处理。\n';

    expect(hasTestExecutionEvidence(report)).toBe(false);
  });

  it('binds a passed acceptance item to an actual passing test record', () => {
    const report = '# 交付报告\n\n## 测试命令\n\n`pnpm test -- list`\n\n## 测试结果\n\nTEST-LIST-01：`pnpm test -- list`；退出码：0。\n';
    expect(() => validateAcceptanceTestEvidence({
      report,
      tests: { schemaVersion: 'aiw.test-results/v1', runId: 'run-1', items: [{ id: 'TEST-LIST-01', command: 'pnpm test -- list', status: 'passed', exitCode: 0, summary: '列表测试已执行且全部通过。', evidencePath: 'runs/run-1/tests/TEST-LIST-01.json', evidenceSha256: 'a'.repeat(64) }] },
      acceptance: { schemaVersion: 'aiw.acceptance-results/v1', items: [{ id: 'AC-01', status: 'passed', evidence: ['artifacts/delivery.md'], testResultRefs: ['TEST-LIST-01'] }] },
    })).not.toThrow();
  });

  it('rejects a passed acceptance item that points to a failed test record', () => {
    expect(() => validateAcceptanceTestEvidence({
      report: '# 交付报告\n\n## 测试命令\n\n`pnpm test -- list`\n\n## 测试结果\n\nTEST-LIST-01：`pnpm test -- list`；退出码：1。\n',
      tests: { schemaVersion: 'aiw.test-results/v1', runId: 'run-1', items: [{ id: 'TEST-LIST-01', command: 'pnpm test -- list', status: 'failed', exitCode: 1, summary: '列表测试已执行但存在失败用例。', evidencePath: 'runs/run-1/tests/TEST-LIST-01.json', evidenceSha256: 'a'.repeat(64) }] },
      acceptance: { schemaVersion: 'aiw.acceptance-results/v1', items: [{ id: 'AC-01', status: 'passed', evidence: ['artifacts/delivery.md'], testResultRefs: ['TEST-LIST-01'] }] },
    })).toThrow('实际通过且退出码为 0');
  });
});
