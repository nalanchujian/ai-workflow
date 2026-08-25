import { describe, expect, it } from 'vitest';

import {
  DesignAssetsSchema,
  FigmaDesignInputSchema,
  parseFigmaDesignUrl,
} from '../../src/domain/design.js';

describe('design contracts', () => {
  it('parses a node-specific Figma Design URL for browser analysis', () => {
    expect(parseFigmaDesignUrl('https://www.figma.com/design/file-key/file-name?node-id=9272-292810&m=dev'))
      .toEqual({ fileKey: 'file-key', nodeId: '9272:292810' });
    expect(parseFigmaDesignUrl('https://www.figma.com/design/file-key/file-name')).toBeUndefined();
  });

  it('accepts only delivery-level page and dialog screenshots from a Ready for dev section', () => {
    const source = FigmaDesignInputSchema.parse({
      provider: 'figma',
      url: 'https://www.figma.com/design/file-key/file-name?node-id=9272-292810',
      fileKey: 'file-key',
      nodeId: '9272:292810',
    });

    expect(DesignAssetsSchema.parse({
      schemaVersion: 'aiw.design-assets/v1',
      analysisStatus: 'completed',
      source,
      assets: [{
        id: 'tracking-links-page',
        figmaUrl: 'https://www.figma.com/design/file-key/file-name?node-id=9272-292811',
        nodeId: '9272:292811',
        sectionNodeId: '9272:292810',
        title: 'Performance overview',
        kind: 'page',
        imagePath: 'artifacts/design/assets/tracking-links-page.png',
      }],
    })).toMatchObject({ assets: [{ nodeId: '9272:292811' }] });
  });

  it('requires a blocking reason when the browser cannot read the design', () => {
    const source = FigmaDesignInputSchema.parse({
      provider: 'figma',
      url: 'https://www.figma.com/design/file-key/file-name?node-id=9272-292810',
      fileKey: 'file-key',
      nodeId: '9272:292810',
    });

    expect(DesignAssetsSchema.parse({
      schemaVersion: 'aiw.design-assets/v1',
      analysisStatus: 'blocked',
      blockingReason: 'Figma 画布与图层持续停留在加载占位。',
      source,
      assets: [],
    })).toMatchObject({ analysisStatus: 'blocked', assets: [] });

    expect(() => DesignAssetsSchema.parse({
      schemaVersion: 'aiw.design-assets/v1',
      analysisStatus: 'blocked',
      source,
      assets: [],
    })).toThrow();
  });

  it('rejects internal wrapper nodes and screenshot paths outside the design asset directory', () => {
    const source = FigmaDesignInputSchema.parse({
      provider: 'figma', url: 'https://www.figma.com/design/file-key/file-name?node-id=9272-292810',
      fileKey: 'file-key', nodeId: '9272:292810',
    });
    const asset = {
      id: 'number-badge', figmaUrl: source.url, nodeId: '9272:292811', sectionNodeId: source.nodeId,
      title: 'Frame 1321319155', kind: 'component', imagePath: 'artifacts/design/assets/number-badge.png',
    };
    expect(() => DesignAssetsSchema.parse({ schemaVersion: 'aiw.design-assets/v1', analysisStatus: 'completed', source, assets: [asset] })).toThrow();
    expect(() => DesignAssetsSchema.parse({ schemaVersion: 'aiw.design-assets/v1', analysisStatus: 'completed', source, assets: [{ ...asset, kind: 'page', imagePath: '../number-badge.png' }] })).toThrow();
  });
});
