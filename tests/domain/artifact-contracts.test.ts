import { describe, expect, it } from 'vitest';

import { markdownArtifactContractFor, validateMarkdownArtifactContract } from '../../src/domain/artifact-contracts.js';

describe('Markdown artifact contracts', () => {
  it('uses each artifact title as its example rather than an unrelated requirement summary', () => {
    const guidance = markdownArtifactContractFor(['artifacts/development/unit/result.md']);
    expect(guidance).toContain('# 开发结果');
    expect(guidance).toContain('可包含业务单元名称');
    expect(guidance).not.toContain('# 需求摘要');
  });

  it('rejects a development result that omits required development sections', () => {
    expect(() => validateMarkdownArtifactContract('artifacts/development/development-unit-main-list/result.md', '# 开发结果\n\n## 完成的代码修改\n\n完成页面。\n'))
      .toThrow('缺少章节「## 变更文件」「## 未解决问题」「## 已知风险」');
  });

  it('accepts a complete solution document', () => {
    expect(() => validateMarkdownArtifactContract('artifacts/solution/solution.md', [
      '# 技术方案', '## 方案结论', '采用现有接口。', '## 架构与接口影响', '无新增依赖。', '## 风险与待决事项', '无。',
    ].join('\n\n'))).not.toThrow();
  });
});
