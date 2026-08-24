import { describe, expect, it } from 'vitest';

import {
  DesignCatalogSchema,
  DesignRulesSchema,
  FigmaDesignInputSchema,
} from '../../src/domain/design.js';

describe('design contracts', () => {
  it('accepts a Figma root input and scoped child-node catalog', () => {
    const source = FigmaDesignInputSchema.parse({
      provider: 'figma',
      url: 'https://www.figma.com/design/file-key/file-name?node-id=9272-292810',
      fileKey: 'file-key',
      nodeId: '9272:292810',
    });

    expect(DesignCatalogSchema.parse({
      schemaVersion: 'aiw.design-catalog/v1',
      source,
      items: [{
        figmaUrl: 'https://www.figma.com/design/file-key/file-name?node-id=9272-292811',
        nodeId: '9272:292811',
        title: 'Performance overview',
        kind: 'page',
        purpose: '默认页面和筛选状态',
        states: ['default', 'loading'],
      }],
    })).toMatchObject({ items: [{ nodeId: '9272:292811' }] });
  });

  it('keeps shared rules and unresolved design questions separate', () => {
    const rules = DesignRulesSchema.parse({
      schemaVersion: 'aiw.design-rules/v1',
      rules: [{ category: 'interaction', statement: '切换时保留当前筛选。', nodeIds: ['9272:292811'] }],
      openQuestions: [{
        question: '空状态是否显示引导按钮？',
        background: '设计稿同时出现两种空状态。',
        impact: '影响页面交互和文案。',
        nodeId: '9272:292811',
      }],
    });

    expect(rules).toMatchObject({ rules: [{ category: 'interaction' }], openQuestions: [{ nodeId: '9272:292811' }] });
  });
});
