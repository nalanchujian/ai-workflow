import { describe, expect, it } from 'vitest';

import {
  DesignAssetsSchema,
  DesignInputSchema,
} from '../../src/domain/design.js';

describe('design contracts', () => {
  it('accepts task-local exported design images without external design metadata', () => {
    expect(DesignInputSchema.parse({
      provider: 'local-images',
      images: [
        { id: 'tracking-links', originalName: 'tracking-links.png', imagePath: 'sources/design/tracking-links.png', mediaType: 'image/png' },
        { id: 'performance', originalName: 'performance.jpg', imagePath: 'sources/design/performance.jpg', mediaType: 'image/jpeg' },
      ],
    }).images).toHaveLength(2);
  });

  it('records every cut asset and binds it to at least one development unit', () => {
    const source = DesignInputSchema.parse({
      provider: 'local-images',
      images: [{ id: 'tracking-links', originalName: 'tracking-links.png', imagePath: 'sources/design/tracking-links.png', mediaType: 'image/png' }],
    });
    const catalog = DesignAssetsSchema.parse({
      schemaVersion: 'aiw.design-assets/v1',
      source,
      coverage: { sourceImageCount: 1, logicalBlockCount: 1 },
      assets: [{
        id: 'tracking-links-page',
        sourceImageId: 'tracking-links',
        title: 'Tracking links 主列表',
        kind: 'page',
        imagePath: 'artifacts/design/assets/tracking-links-page.png',
        purpose: '主列表布局与状态',
        developmentUnits: ['development-unit-main-list'],
      }],
    });

    expect(catalog.assets[0]?.developmentUnits).toEqual(['development-unit-main-list']);
  });

  it('rejects incomplete coverage, unknown source images and unbound assets', () => {
    const source = {
      provider: 'local-images',
      images: [{ id: 'tracking-links', originalName: 'tracking-links.png', imagePath: 'sources/design/tracking-links.png', mediaType: 'image/png' }],
    };
    const asset = {
      id: 'tracking-links-page', sourceImageId: 'missing', title: 'Tracking links', kind: 'page',
      imagePath: 'artifacts/design/assets/tracking-links-page.png', purpose: '主列表', developmentUnits: [],
    };
    expect(() => DesignAssetsSchema.parse({
      schemaVersion: 'aiw.design-assets/v1', source,
      coverage: { sourceImageCount: 1, logicalBlockCount: 1 }, assets: [asset],
    })).toThrow();
    expect(() => DesignAssetsSchema.parse({
      schemaVersion: 'aiw.design-assets/v1', source,
      coverage: { sourceImageCount: 1, logicalBlockCount: 2 },
      assets: [{ ...asset, sourceImageId: 'tracking-links', developmentUnits: ['development-unit-main-list'] }],
    })).toThrow(/逻辑业务块/);
  });
});
