import { z } from 'zod';

const kebabId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const taskImagePath = /^sources\/design\/[a-z][a-z0-9-]*\.(?:png|jpe?g)$/i;
const assetImagePath = /^artifacts\/design\/assets\/[a-z][a-z0-9-]*\.(?:png|jpe?g)$/i;
const developmentUnitName = /^development-unit-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const DesignImageInputSchema = z.object({
  id: z.string().regex(kebabId, '设计图片 ID 必须使用英文 kebab-case'),
  originalName: z.string().min(1),
  imagePath: z.string().regex(taskImagePath, '设计原图必须位于 sources/design/'),
  mediaType: z.enum(['image/png', 'image/jpeg']),
}).strict();

export const DesignInputSchema = z.object({
  provider: z.literal('local-images'),
  images: z.array(DesignImageInputSchema).min(1),
}).strict().superRefine((input, context) => {
  if (new Set(input.images.map((image) => image.id)).size !== input.images.length) {
    context.addIssue({ code: 'custom', path: ['images'], message: '设计图片 ID 必须唯一' });
  }
  if (new Set(input.images.map((image) => image.imagePath)).size !== input.images.length) {
    context.addIssue({ code: 'custom', path: ['images'], message: '设计图片路径必须唯一' });
  }
});

export const DesignReferenceSchema = z.object({
  assetId: z.string().regex(kebabId, '设计截图 ID 必须使用英文 kebab-case'),
  imagePath: z.string().regex(assetImagePath, '设计截图必须位于 artifacts/design/assets/'),
  purpose: z.string().min(1),
}).strict();

const DesignAssetSchema = z.object({
  id: z.string().regex(kebabId, '设计截图 ID 必须使用英文 kebab-case'),
  sourceImageId: z.string().regex(kebabId, '来源图片 ID 必须使用英文 kebab-case'),
  title: z.string().min(1),
  kind: z.enum(['block', 'page', 'dialog', 'drawer', 'popover', 'state']),
  imagePath: z.string().regex(assetImagePath, '设计截图必须位于 artifacts/design/assets/'),
  purpose: z.string().min(1),
  developmentUnits: z.array(z.string().regex(developmentUnitName)).min(1),
}).strict();

export const DesignAssetsSchema = z.object({
  schemaVersion: z.literal('aiw.design-assets/v1'),
  source: DesignInputSchema,
  coverage: z.object({
    sourceImageCount: z.number().int().positive(),
    logicalBlockCount: z.number().int().positive(),
  }).strict(),
  assets: z.array(DesignAssetSchema).min(1),
}).strict().superRefine((catalog, context) => {
  if (catalog.coverage.sourceImageCount !== catalog.source.images.length) {
    context.addIssue({ code: 'custom', path: ['coverage', 'sourceImageCount'], message: '来源图片数量必须等于任务输入图片数量' });
  }
  if (catalog.coverage.logicalBlockCount !== catalog.assets.length) {
    context.addIssue({ code: 'custom', path: ['coverage', 'logicalBlockCount'], message: '逻辑业务块数量必须等于实际切割图片数量' });
  }
  const sourceIds = new Set(catalog.source.images.map((image) => image.id));
  for (const [index, asset] of catalog.assets.entries()) {
    if (!sourceIds.has(asset.sourceImageId)) {
      context.addIssue({ code: 'custom', path: ['assets', index, 'sourceImageId'], message: `引用了未知来源图片：${asset.sourceImageId}` });
    }
  }
  if (new Set(catalog.assets.map((asset) => asset.id)).size !== catalog.assets.length) {
    context.addIssue({ code: 'custom', path: ['assets'], message: '设计截图 ID 必须唯一' });
  }
  if (new Set(catalog.assets.map((asset) => asset.imagePath)).size !== catalog.assets.length) {
    context.addIssue({ code: 'custom', path: ['assets'], message: '设计截图路径必须唯一' });
  }
});

export type DesignImageInput = z.infer<typeof DesignImageInputSchema>;
export type DesignInput = z.infer<typeof DesignInputSchema>;
export type DesignReference = z.infer<typeof DesignReferenceSchema>;
export type DesignAssets = z.infer<typeof DesignAssetsSchema>;
