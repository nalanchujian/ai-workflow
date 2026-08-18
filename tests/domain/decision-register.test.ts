import { describe, expect, it } from 'vitest';

import { DecisionRegisterSchema } from '../../src/domain/decision-register.js';

describe('DecisionRegisterSchema', () => {
  it('accepts AI continuation proposals with one scoped acceptance impact', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [decision()],
    })).not.toThrow();
  });

  it('rejects a decision that combines multiple acceptance items', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{ ...decision(), affects: { acceptanceRefs: ['AC-07', 'AC-08'], workUnits: ['performance-overview'] } }],
    })).toThrow(/只能关联一个/);
  });

  it('rejects legacy workflow state fields so proposal and resolution facts cannot diverge', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{ ...decision(), status: 'proposed' }],
    })).toThrow(/Unrecognized key/);
  });

  it('limits AI alternatives to two so the review interaction stays concise', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{
        ...decision(),
        options: [
          { id: 'formal-api', title: '使用正式接口', tradeoffs: '可完成联调，但需要确认字段粒度。' },
          { id: 'mock-ui', title: '使用 Mock', tradeoffs: '可以先验证界面，但不能完成接口验收。' },
          { id: 'existing-data', title: '复用现有数据', tradeoffs: '接入成本较低，但数据口径可能不完整。' },
        ],
      }],
    })).toThrow(/最多两个/);
  });

  it('rejects obsolete workflow effects on an option', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{ ...decision(), options: [{ id: 'formal-api', title: '使用正式接口', tradeoffs: '可完成联调并保持字段口径一致。', effect: 'resolved' }] }],
    })).toThrow(/Unrecognized key/);
  });
});

function decision() {
  return {
    id: 'DEC-API-01',
    title: '详情趋势数据来源',
    detail: {
      question: '详情趋势与导出本期使用哪一套服务端接口？',
      background: '当前需求与仓库未提供趋势、导出和日期聚合的统一契约。',
      impact: '不确认会使页面、导出与验收采用不同的数据口径。',
    },
    type: 'external-contract',
    factRefs: ['FACT-API-01'],
    affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] },
    options: [
      { id: 'formal-api', title: '使用正式 API', tradeoffs: '可以联调并完成真实验收，但需要确认字段契约。' },
      { id: 'mock-ui', title: '使用 Mock', tradeoffs: '可以先验证界面，但不能证明正式接口已通过。' },
    ],
    recommendation: { optionId: 'formal-api', rationale: '正式接口最符合最终验收目标。' },
  };
}
