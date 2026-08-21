import { describe, expect, it } from 'vitest';

import { validateDevelopmentResult } from '../../src/domain/development-result.js';

describe('validateDevelopmentResult', () => {
  it('accepts a readable development summary', () => {
    expect(() => validateDevelopmentResult([
      '# 开发结果',
      '',
      '## 完成的代码修改',
      '',
      '- 增加指标配置持久化。',
      '',
      '## 变更文件',
      '',
      '- `src/metrics.ts`',
      '',
      '## 未解决问题',
      '',
      '- 无。',
      '',
      '## 已知风险',
      '',
      '- 尚未执行自动化测试。',
    ].join('\n'))).not.toThrow();
  });

  it('rejects reports that claim tests or acceptance passed', () => {
    expect(() => validateDevelopmentResult([
      '# 开发结果',
      '## 完成的代码修改',
      '- 完成修改。',
      '## 变更文件',
      '- `src/metrics.ts`',
      '## 未解决问题',
      '- 无。',
      '## 已知风险',
      '- 测试通过，验收完成。',
    ].join('\n'))).toThrow(/不能声称/);
  });
});
