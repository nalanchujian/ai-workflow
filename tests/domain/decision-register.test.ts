import { describe, expect, it } from 'vitest';

import { DecisionRegisterSchema, unresolvedBlockingDecisionIds } from '../../src/domain/decision-register.js';

describe('DecisionRegisterSchema', () => {
  it('accepts an AI recommendation and a human-selected option with scoped acceptance impact', () => {
    const register = DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{
        id: 'DEC-API-01',
        title: '详情趋势数据来源',
        type: 'external-contract',
        affects: { acceptanceRefs: ['AC-07', 'AC-08'], workUnits: ['performance-overview'] },
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
        type: 'external-contract',
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

  it('rejects a resolution that selects an undeclared option', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{
        id: 'DEC-API-01',
        title: '详情趋势数据来源',
        type: 'external-contract',
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

  it('requires an alternative to the AI recommendation so a user can make a real choice', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{
        id: 'DEC-API-01', title: '详情趋势数据来源', type: 'external-contract',
        affects: { acceptanceRefs: ['AC-07'], workUnits: ['performance-overview'] }, status: 'proposed',
        options: [{ id: 'wait-api', title: '等待正式 API', tradeoffs: '交付依赖后端排期。', effect: 'waiting_external' }],
        recommendation: { optionId: 'wait-api', rationale: '现有接口不能满足验收。' },
      }],
    })).toThrow(/至少两个/);
  });

  it('requires each option to declare its workflow effect', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v1',
      items: [{
        id: 'DEC-API-01', title: '详情趋势数据来源', type: 'external-contract',
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
