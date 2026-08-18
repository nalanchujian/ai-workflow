import { describe, expect, it } from 'vitest';

import { DecisionRegisterSchema, unresolvedBlockingDecisionIds } from '../../src/domain/decision-register.js';

describe('DecisionRegisterSchema', () => {
  it('accepts an AI recommendation and a human-selected option with scoped acceptance impact', () => {
    const register = DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{
        id: 'DEC-API-01',
        title: '详情趋势数据来源',
        detail: decisionDetail(),
        type: 'external-contract',
        factRefs: ['FACT-API-01'],
        affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] },
        status: 'resolved',
        options: [
          { id: 'wait-api', title: '等待正式 API', tradeoffs: '交付依赖后端，但口径一致。', effect: 'waiting_external' },
          { id: 'defer-scope', title: '拆至后续版本', tradeoffs: '当前范围缩小，需要后续跟踪。', effect: 'deferred' },
        ],
        recommendation: { optionId: 'wait-api', rationale: '当前仓库没有可信详情与趋势接口。' },
        resolution: { optionId: 'wait-api', actor: 'tech-lead', at: '2026-08-14T00:00:00.000Z', owner: 'backend', unblockCondition: 'API 契约与联调样例已确认' },
      }],
    });

    expect(unresolvedBlockingDecisionIds(register, 'performance-overview')).toEqual([]);
  });

  it('returns decisions that still block their affected work unit', () => {
    const register = DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{
        id: 'DEC-API-01',
        title: '详情趋势数据来源',
        detail: decisionDetail(),
        type: 'external-contract',
        factRefs: ['FACT-API-01'],
        affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] },
        status: 'waiting_external',
        options: [
          { id: 'wait-api', title: '等待正式 API', tradeoffs: '交付依赖后端排期。', effect: 'waiting_external' },
          { id: 'defer-scope', title: '拆至后续版本', tradeoffs: '当前范围缩小，需要后续跟踪。', effect: 'deferred' },
        ],
        recommendation: { optionId: 'wait-api', rationale: '现有接口不能满足验收。' },
        resolution: { optionId: 'wait-api', actor: 'tech-lead', at: '2026-08-14T00:00:00.000Z', owner: 'backend', unblockCondition: 'API 契约与联调样例已确认' },
      }],
    });

    expect(unresolvedBlockingDecisionIds(register, 'performance-overview')).toEqual(['DEC-API-01']);
  });

  it('rejects a decision that combines multiple acceptance items', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{
        id: 'DEC-API-01', title: '详情趋势数据来源', detail: decisionDetail(), type: 'external-contract', factRefs: ['FACT-API-01'],
        affects: { acceptanceRefs: ['AC-07', 'AC-08'], workUnits: ['performance-overview'] }, status: 'proposed',
        options: [{ id: 'mock-ui', title: '使用 Mock', tradeoffs: '可以先验证界面，但不能完成接口验收。', effect: 'resolved' }],
        recommendation: { optionId: 'mock-ui', rationale: '当前没有可信详情接口。' },
      }],
    })).toThrow(/只能关联一个/);
  });

  it('rejects a resolution that selects an undeclared option', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{
        id: 'DEC-API-01',
        title: '详情趋势数据来源',
        detail: decisionDetail(),
        type: 'external-contract',
        factRefs: ['FACT-API-01'],
        affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] },
        status: 'resolved',
        options: [
          { id: 'wait-api', title: '等待正式 API', tradeoffs: '交付依赖后端。', effect: 'waiting_external' },
          { id: 'defer-scope', title: '拆至后续版本', tradeoffs: '当前范围缩小，需要后续跟踪。', effect: 'deferred' },
        ],
        recommendation: { optionId: 'wait-api', rationale: '现有接口不能满足验收。' },
        resolution: { optionId: 'invented', actor: 'tech-lead', at: '2026-08-14T00:00:00.000Z' },
      }],
    })).toThrow(/选项/);
  });

  it('allows one AI continuation option because task review always retains a manual-input path', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{
        id: 'DEC-API-01', title: '详情趋势数据来源', detail: decisionDetail(), type: 'external-contract', factRefs: ['FACT-API-01'],
        affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] }, status: 'proposed',
        options: [{ id: 'wait-api', title: '等待正式 API', tradeoffs: '交付依赖后端排期。', effect: 'waiting_external' }],
        recommendation: { optionId: 'wait-api', rationale: '现有接口不能满足验收。' },
      }],
    })).not.toThrow();
  });

  it('limits AI alternatives to two so the review interaction stays concise', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{
        id: 'DEC-API-01', title: '详情趋势数据来源', detail: decisionDetail(), type: 'external-contract', factRefs: ['FACT-API-01'],
        affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] }, status: 'proposed',
        options: [
          { id: 'formal-api', title: '使用正式接口', tradeoffs: '可完成联调，但需要确认字段粒度。', effect: 'resolved' },
          { id: 'mock-ui', title: '使用 Mock', tradeoffs: '可以先验证界面，但不能完成接口验收。', effect: 'resolved' },
          { id: 'existing-data', title: '复用现有数据', tradeoffs: '接入成本较低，但数据口径可能不完整。', effect: 'resolved' },
        ],
        recommendation: { optionId: 'formal-api', rationale: '正式接口最符合最终验收目标。' },
      }],
    })).toThrow(/最多两个/);
  });

  it('requires each option to declare its workflow effect', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{
        id: 'DEC-API-01', title: '详情趋势数据来源', detail: decisionDetail(), type: 'external-contract', factRefs: ['FACT-API-01'],
        affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] }, status: 'proposed',
        options: [
          { id: 'wait-api', title: '等待正式 API', tradeoffs: '交付依赖后端排期，但口径一致。' },
          { id: 'mock-only', title: '先使用 Mock', tradeoffs: '可提前验证界面，但不能验证真实接口。' },
        ],
        recommendation: { optionId: 'wait-api', rationale: '现有接口不能满足验收。' },
      }],
    })).toThrow(/effect/);
  });
});

function decisionDetail() {
  return {
    question: '详情趋势与导出本期使用哪一套服务端接口？',
    background: '当前需求与仓库未提供趋势、导出和日期聚合的统一契约。',
    impact: '不确认会使页面、导出与验收采用不同的数据口径。',
  };
}
