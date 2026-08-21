import { describe, expect, it } from 'vitest';

import { DecisionRegisterSchema } from '../../src/domain/decision-register.js';

describe('DecisionRegisterSchema', () => {
  it('keeps pending, current-scope, and deferred decisions in one register without IDs', () => {
    const register = DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v2',
      pendingDecisions: [{
        question: 'Selected data 使用哪些导出字段？',
        background: '当前页面存在可见字段配置，但接口契约没有说明字段顺序。',
        impact: '决定本期导出代码如何组装字段参数。',
        options: [
          { title: '使用当前页面可见字段', tradeoffs: '与页面一致，但依赖服务端接受字段列表。' },
          { title: '只使用默认字段', tradeoffs: '实现简单，但本期不支持自定义导出字段。' },
        ],
        recommendation: { option: 0, rationale: '与当前指标配置行为保持一致。' },
      }],
      currentDecisions: [{
        question: '指标配置保存在哪里？',
        selectedApproach: '保存到浏览器本地存储',
        rationale: '当前没有服务端保存接口。',
      }],
      deferredItems: [{
        requirement: 'Performance overview 邮件发送',
        reason: '缺少正式邮件服务接口。',
        suggestedNextStep: '接口明确后创建独立任务。',
      }],
    });

    expect(register.pendingDecisions).toHaveLength(1);
    expect(register.currentDecisions).toHaveLength(1);
    expect(register.deferredItems).toHaveLength(1);
  });

  it('limits AI options to two and requires the recommendation to reference one', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v2',
      pendingDecisions: [{
        question: '本期采用哪种字段规则？',
        background: '当前需求没有明确字段选择和空值处理规则。',
        impact: '决定本期代码范围和数据结构。',
        options: [
          { title: '方案一', tradeoffs: '可以快速实现，但存在接口差异风险。' },
          { title: '方案二', tradeoffs: '范围更小，但功能覆盖不完整。' },
          { title: '方案三', tradeoffs: '实现完整，但当前成本过高。' },
        ],
        recommendation: { option: 2, rationale: '推荐完整实现。' },
      }],
      currentDecisions: [],
      deferredItems: [],
    })).toThrow(/最多两个/);
  });

  it('rejects legacy DEC, FACT, AC, and work-unit references', () => {
    expect(() => DecisionRegisterSchema.parse({
      schemaVersion: 'aiw.decision-register/v2',
      pendingDecisions: [{
        id: 'DEC-API-01',
        question: '本期采用哪种字段规则？',
        background: '当前需求没有明确字段选择和空值处理规则。',
        impact: '决定本期代码范围和数据结构。',
        factRefs: ['FACT-API-01'],
        affects: { acceptanceRefs: ['AC-01'], workUnits: ['list-export'] },
        options: [{ title: '方案一', tradeoffs: '可以快速实现，但存在接口差异风险。' }],
        recommendation: { option: 0, rationale: '当前可以直接开始开发。' },
      }],
      currentDecisions: [],
      deferredItems: [],
    })).toThrow(/Unrecognized key/);
  });
});
