import { describe, expect, it } from 'vitest';

import { DevelopmentPlanSchema } from '../../src/domain/work-breakdown.js';

describe('DevelopmentPlanSchema', () => {
  it('accepts self-contained development units without verification or cross-node references', () => {
    const plan = DevelopmentPlanSchema.parse({
      schemaVersion: 'aiw.development-plan/v1',
      units: [{
        name: 'development-unit-main-list-metrics',
        title: '主列表指标配置',
        goal: '支持调整并保存主列表指标。',
        requirements: ['支持调整指标顺序', '支持保存用户配置'],
        codeScope: ['src/pages/growth/links/components/custom-metrics/'],
        steps: ['调整指标配置模型', '接入本地持久化'],
        dependencies: [],
      }],
    });

    expect(plan.units[0]).toMatchObject({
      name: 'development-unit-main-list-metrics',
      title: '主列表指标配置',
    });
  });

  it('rejects acceptance, fact, decision, and verification mappings', () => {
    expect(() => DevelopmentPlanSchema.parse({
      schemaVersion: 'aiw.development-plan/v1',
      units: [{
        name: 'development-unit-main-list-metrics',
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

  it('requires a unique semantic English name for every development unit', () => {
    const unit = {
      title: '主列表指标配置',
      goal: '支持调整并保存主列表指标。',
      requirements: ['支持调整指标顺序'],
      codeScope: ['src/pages/growth/links/components/custom-metrics/'],
      steps: ['调整指标配置模型'],
      dependencies: [],
    };

    expect(() => DevelopmentPlanSchema.parse({
      schemaVersion: 'aiw.development-plan/v1',
      units: [{ ...unit, name: 'development-unit-1' }],
    })).toThrow(/development-unit-<英文 kebab-case 描述>/);
    expect(() => DevelopmentPlanSchema.parse({
      schemaVersion: 'aiw.development-plan/v1',
      units: [{ ...unit, name: 'development-unit-主列表指标' }],
    })).toThrow(/development-unit-<英文 kebab-case 描述>/);
    expect(() => DevelopmentPlanSchema.parse({
      schemaVersion: 'aiw.development-plan/v1',
      units: [
        { ...unit, name: 'development-unit-main-list-metrics' },
        { ...unit, title: '主列表导出', name: 'development-unit-main-list-metrics' },
      ],
    })).toThrow(/开发单元名称必须唯一/);
  });

  it('requires dependencies to reference semantic development unit names', () => {
    expect(() => DevelopmentPlanSchema.parse({
      schemaVersion: 'aiw.development-plan/v1',
      units: [
        {
          name: 'development-unit-main-list-metrics', title: '主列表指标配置', goal: '配置指标',
          requirements: ['支持配置'], codeScope: ['src/metrics'], steps: ['实现配置'], dependencies: [],
        },
        {
          name: 'development-unit-main-list-export', title: '主列表导出', goal: '导出指标',
          requirements: ['支持导出'], codeScope: ['src/export'], steps: ['实现导出'], dependencies: ['主列表指标配置'],
        },
      ],
    })).toThrow(/未知开发单元名称/);
  });
});
