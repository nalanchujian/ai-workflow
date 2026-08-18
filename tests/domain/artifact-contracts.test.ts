import { describe, expect, it } from 'vitest';

import { validateMarkdownArtifactContract } from '../../src/domain/artifact-contracts.js';

describe('Markdown artifact contracts', () => {
  it('rejects an implementation report that omits evidence sections', () => {
    expect(() => validateMarkdownArtifactContract('artifacts/delivery.md', '# 交付报告\n\n## 实际变更\n\n完成页面。\n'))
      .toThrow('缺少章节「## 工程验证」「## 测试命令」「## 测试结果」「## 逐项验收」「## 未完成事项与风险」');
  });

  it('accepts a complete test report structure', () => {
    expect(() => validateMarkdownArtifactContract('artifacts/test-report.md', [
      '# 测试报告',
      '## 测试命令',
      'pnpm test',
      '## 测试结果',
      '通过',
      '## 逐项验收',
      'AC-01 通过',
      '## 阻塞缺陷与风险',
      '无',
      '## 建议的下一步',
      '提交结论',
    ].join('\n'))).not.toThrow();
  });
});
