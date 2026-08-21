import { describe, expect, it } from 'vitest';

import { DevelopmentPlanSchema } from '../../src/domain/work-breakdown.js';

describe('DevelopmentPlanSchema', () => {
  it('accepts self-contained development units without verification or cross-node references', () => {
    const plan = DevelopmentPlanSchema.parse({
      schemaVersion: 'aiw.development-plan/v1',
      units: [{
        title: '主列表指标配置',
        goal: '支持调整并保存主列表指标。',
        requirements: ['支持调整指标顺序', '支持保存用户配置'],
        codeScope: ['src/pages/growth/links/components/custom-metrics/'],
        steps: ['调整指标配置模型', '接入本地持久化'],
        dependencies: [],
      }],
    });

    expect(plan.units[0]?.title).toBe('主列表指标配置');
  });

  it('rejects acceptance, fact, decision, and verification mappings', () => {
    expect(() => DevelopmentPlanSchema.parse({
      schemaVersion: 'aiw.development-plan/v1',
      units: [{
        title: '主列表指标配置',
        goal: '支持调整并保存主列表指标。',
        requirements: ['支持调整指标顺序'],
        codeScope: ['src/pages/growth/links/components/custom-metrics/'],
        steps: ['调整指标配置模型'],
        dependencies: [],
        acceptanceRefs: ['AC-01'],
        factRefs: ['FACT-LIST-01'],
        decisionRefs: ['DEC-LIST-01'],
        verification: [{ command: 'pnpm test' }],
      }],
    })).toThrow(/Unrecognized key/);
  });
});
