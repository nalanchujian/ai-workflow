import { z } from 'zod';

const kebabId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const taskImagePath = /^sources\/design\/[a-z][a-z0-9-]*\.(?:png|jpe?g)$/i;
const assetImagePath = /^artifacts\/design\/assets\/[a-z][a-z0-9-]*\.(?:png|jpe?g)$/i;

export const DesignImageInputSchema = z.object({
  id: z.string().regex(kebabId, '设计图片 ID 必须使用英文 kebab-case'),
  originalName: z.string().min(1),
  imagePath: z.string().regex(taskImagePath, '设计原图必须位于 sources/design/'),
  mediaType: z.enum(['image/png', 'image/jpeg']),
}).strict().superRefine((image, context) => {
  const expected = /\.png$/i.test(image.imagePath) ? 'image/png' : 'image/jpeg';
  if (image.mediaType !== expected) context.addIssue({ code: 'custom', path: ['mediaType'], message: '图片类型必须与扩展名一致' });
});

export const DesignInputSchema = z.object({ image: DesignImageInputSchema }).strict();

/** Plans refer to catalog IDs. Physical paths are resolved by AIW. */
export const DesignReferenceSchema = z.object({
  assetId: z.string().regex(kebabId, '设计截图 ID 必须使用英文 kebab-case'),
  purpose: z.string().min(1),
}).strict();

export const ResolvedDesignReferenceSchema = DesignReferenceSchema.extend({
  imagePath: z.string().regex(assetImagePath, '设计截图必须位于 artifacts/design/assets/'),
}).strict();

export const DesignAssetSchema = z.object({
  id: z.string().regex(kebabId),
  sourceImageId: z.string().regex(kebabId),
  title: z.string().min(1),
  imagePath: z.string().regex(assetImagePath),
  crop: z.object({
    x: z.number().int().nonnegative(), y: z.number().int().nonnegative(),
    width: z.number().int().positive(), height: z.number().int().positive(),
  }).strict(),
}).strict();

export const DesignAssetsSchema = z.object({
  schemaVersion: z.literal('aiw.design-assets/v2'),
  source: DesignInputSchema,
  sourceSize: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  assets: z.array(DesignAssetSchema).min(1),
}).strict().superRefine((catalog, context) => {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [index, asset] of catalog.assets.entries()) {
    const issue = (field: string, message: string) => context.addIssue({ code: 'custom', path: ['assets', index, field], message });
    if (asset.sourceImageId !== catalog.source.image.id) issue('sourceImageId', '引用了未知来源图片');
    if (ids.has(asset.id)) issue('id', '设计截图 ID 必须唯一');
    if (paths.has(asset.imagePath)) issue('imagePath', '设计截图路径必须唯一');
    if (asset.crop.x + asset.crop.width > catalog.sourceSize.width || asset.crop.y + asset.crop.height > catalog.sourceSize.height) issue('crop', '裁切范围超出原图尺寸');
    ids.add(asset.id);
    paths.add(asset.imagePath);
  }
});

export type DesignImageInput = z.infer<typeof DesignImageInputSchema>;
export type DesignInput = z.infer<typeof DesignInputSchema>;
export type DesignReference = z.infer<typeof DesignReferenceSchema>;
export type DesignAssets = z.infer<typeof DesignAssetsSchema>;
