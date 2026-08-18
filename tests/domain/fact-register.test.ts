import { describe, expect, it } from 'vitest';

import { FactRegisterSchema } from '../../src/domain/fact-register.js';

const evidence = [{ sourceId: 'requirements', path: 'sources/requirements/r1/snapshot.md', locator: '导出规则' }];

describe('FactRegister', () => {
  it('keeps confirmed facts separate from inference and unresolved input', () => {
    expect(FactRegisterSchema.parse({
      schemaVersion: 'aiw.fact-register/v1',
      items: [
        { id: 'FACT-EXPORT-01', kind: 'confirmed', statement: '当前需求要求导出结果与页面选中的字段顺序保持一致。', confidence: 'high', evidence },
        { id: 'FACT-API-01', kind: 'external_dependency', statement: '服务端尚未提供导出字段、空值语义和文件结构的正式契约。', confidence: 'medium', evidence },
      ],
    }).items).toHaveLength(2);
  });

  it('does not permit a guess to pretend it is confirmed', () => {
    expect(() => FactRegisterSchema.parse({
      schemaVersion: 'aiw.fact-register/v1',
      items: [
        { id: 'FACT-API-01', kind: 'inferred', statement: '现有接口可能支持导出字段的选择和自定义排序行为。', confidence: 'high', evidence },
      ],
    })).toThrow('不得标记为 high');
  });
});
