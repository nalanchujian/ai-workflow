import type { DesignImageInput } from '../../src/domain/design.js';

export function designAssets(image: DesignImageInput = { id: 'main', originalName: 'main.png', imagePath: 'sources/design/main.png', mediaType: 'image/png' }) {
  return {
    schemaVersion: 'aiw.design-assets/v2' as const,
    source: { image },
    sourceSize: { width: 800, height: 600 },
    assets: [{ id: 'main-page', sourceImageId: image.id, title: '主页面', imagePath: 'artifacts/design/assets/main-page.png', crop: { x: 0, y: 0, width: 800, height: 600 } }],
  };
}
