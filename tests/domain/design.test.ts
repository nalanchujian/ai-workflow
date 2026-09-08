import { describe, expect, it } from 'vitest';
import { DesignAssetsSchema, DesignInputSchema } from '../../src/domain/design.js';
import { designAssets } from '../helpers/design-assets.js';

describe('design contracts', () => {
  it('accepts exactly one task-local PNG or JPEG', () => {
    const source = designAssets().source;
    expect(DesignInputSchema.parse(source)).toEqual(source);
    expect(DesignInputSchema.parse({ image: { ...source.image, imagePath: 'sources/design/main.jpg', mediaType: 'image/jpeg' } }).image.mediaType).toBe('image/jpeg');
    expect(DesignInputSchema.safeParse({ image: { ...source.image, mediaType: 'image/jpeg' } }).success).toBe(false);
  });
  it('rejects old version, image list, unit binding and design-analysis fields', () => {
    const catalog = designAssets();
    expect(DesignAssetsSchema.safeParse({ ...catalog, schemaVersion: 'aiw.design-assets/v1' }).success).toBe(false);
    expect(DesignInputSchema.safeParse({ provider: 'local-images', images: [catalog.source.image] }).success).toBe(false);
    for (const extra of [{ developmentUnits: ['development-unit-main'] }, { kind: 'page' }, { purpose: '推导交互' }]) expect(DesignAssetsSchema.safeParse({ ...catalog, assets: [{ ...catalog.assets[0], ...extra }] }).success).toBe(false);
  });
  it('rejects unsafe paths, duplicate paths and fractional crop coordinates', () => {
    const catalog = designAssets();
    for (const imagePath of ['../outside.png', 'artifacts/design/assets/../outside.png', '/tmp/image.png']) expect(DesignAssetsSchema.safeParse({ ...catalog, assets: [{ ...catalog.assets[0], imagePath }] }).success).toBe(false);
    expect(DesignAssetsSchema.safeParse({ ...catalog, assets: [catalog.assets[0], { ...catalog.assets[0], id: 'other' }] }).success).toBe(false);
    expect(DesignAssetsSchema.safeParse({ ...catalog, assets: [{ ...catalog.assets[0], crop: { x: 0.5, y: 0, width: 1, height: 1 } }] }).success).toBe(false);
  });
});
