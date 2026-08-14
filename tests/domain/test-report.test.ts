import { describe, expect, it } from 'vitest';

import { hasTestExecutionEvidence } from '../../src/domain/test-report.js';

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
});
