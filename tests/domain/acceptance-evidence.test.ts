import { describe, expect, it } from 'vitest';

import { AcceptanceCatalogSchema } from '../../src/domain/acceptance-catalog.js';

describe('acceptance evidence policy', () => {
  it('requires every AC to declare the evidence type approved during clarification', () => {
    const catalog = AcceptanceCatalogSchema.parse({
      schemaVersion: 'aiw.acceptance-catalog/v2',
      items: [{
        id: 'AC-01',
        title: '指标设置交互',
        description: '用户可以在界面中切换指标并保存选择。',
        factRefs: ['FACT-METRICS-01'],
        evidenceType: 'component',
      }],
    });

    expect(catalog.items[0]?.evidenceType).toBe('component');
    expect(() => AcceptanceCatalogSchema.parse({
      ...catalog,
      items: [{ ...catalog.items[0], evidenceType: undefined }],
    })).toThrow();
  });
});
