import { describe, expect, it } from 'vitest';

import { FactRegisterSchema } from '../../src/domain/fact-register.js';

describe('FactRegisterSchema', () => {
  it('accepts confirmed facts without cross-node IDs', () => {
    const register = FactRegisterSchema.parse({
      schemaVersion: 'aiw.fact-register/v3',
      facts: [{
        statement: '主列表支持用户调整指标显示顺序。',
        source: {
          type: 'requirement',
          path: 'sources/requirements/current/snapshot.md',
          locator: 'Custom metrics',
        },
      }],
    });

    expect(register.facts).toEqual([{ statement: '主列表支持用户调整指标显示顺序。', source: {
      type: 'requirement', path: 'sources/requirements/current/snapshot.md', locator: 'Custom metrics',
    } }]);
  });

  it('rejects old identity and confidence fields', () => {
    expect(() => FactRegisterSchema.parse({
      schemaVersion: 'aiw.fact-register/v3',
      facts: [{
        id: 'FACT-LIST-01',
        kind: 'confirmed',
        statement: '主列表支持用户调整指标显示顺序。',
        confidence: 'high',
        source: { type: 'requirement', path: 'sources/requirements/current/snapshot.md' },
      }],
    })).toThrow(/Unrecognized key/);
  });

  it('requires every fact to identify a readable source path', () => {
    expect(() => FactRegisterSchema.parse({
      schemaVersion: 'aiw.fact-register/v3',
      facts: [{ statement: '主列表支持用户调整指标显示顺序。', source: { type: 'requirement', path: '../outside.md' } }],
    })).toThrow(/相对路径/);
  });
});
