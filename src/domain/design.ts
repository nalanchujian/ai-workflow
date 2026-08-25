import { z } from 'zod';

const figmaNodeIdPattern = /^\d+:\d+$/;

export const FigmaDesignInputSchema = z.object({
  provider: z.literal('figma'),
  url: z.string().url().refine((value) => /^https:\/\/(?:www\.)?figma\.com\/(?:design|file)\//.test(value), '必须是 Figma Design 地址'),
  fileKey: z.string().min(1),
  nodeId: z.string().regex(figmaNodeIdPattern, '必须是标准 Figma 节点 ID，例如 9272:292810'),
}).strict();

export function parseFigmaDesignUrl(input: string): { fileKey: string; nodeId: string } | undefined {
  let url: URL;
  try { url = new URL(input); } catch { return undefined; }
  if (url.protocol !== 'https:' || !['figma.com', 'www.figma.com'].includes(url.hostname)) return undefined;
  const match = /^\/(?:design|file)\/([^/]+)\/.+/.exec(url.pathname);
  const rawNodeId = url.searchParams.get('node-id');
  if (match === null || rawNodeId === null || !/^\d+(?:-|:)\d+$/.test(rawNodeId)) return undefined;
  return { fileKey: match[1], nodeId: rawNodeId.replace('-', ':') };
}

export const DesignReferenceSchema = z.object({
  assetId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, '设计截图 ID 必须使用英文 kebab-case'),
  figmaUrl: z.string().url(),
  nodeId: z.string().regex(figmaNodeIdPattern, '必须是标准 Figma 节点 ID'),
  imagePath: z.string().regex(/^artifacts\/design\/assets\/[a-z][a-z0-9-]*\.(?:png|jpe?g)$/i, '设计截图必须位于 artifacts/design/assets/'),
  purpose: z.string().min(1),
}).strict();

const DesignAssetSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, '设计截图 ID 必须使用英文 kebab-case'),
  figmaUrl: z.string().url(),
  nodeId: z.string().regex(figmaNodeIdPattern, '必须是标准 Figma 节点 ID'),
  sectionNodeId: z.string().regex(figmaNodeIdPattern, '必须是标准 Figma 节点 ID'),
  title: z.string().min(1),
  kind: z.enum(['page', 'dialog', 'drawer', 'popover', 'state']),
  imagePath: z.string().regex(/^artifacts\/design\/assets\/[a-z][a-z0-9-]*\.(?:png|jpe?g)$/i, '设计截图必须位于 artifacts/design/assets/'),
}).strict();

export const DesignAssetsSchema = z.object({
  schemaVersion: z.literal('aiw.design-assets/v1'),
  source: FigmaDesignInputSchema,
  analysisStatus: z.enum(['completed', 'blocked']),
  blockingReason: z.string().min(1).optional(),
  assets: z.array(DesignAssetSchema).default([]),
}).strict().superRefine((catalog, context) => {
  if (catalog.analysisStatus === 'completed' && catalog.assets.length === 0) {
    context.addIssue({ code: 'custom', path: ['assets'], message: '设计分析完成时必须包含至少一张页面或弹窗截图' });
  }
  if (catalog.analysisStatus === 'blocked' && catalog.blockingReason === undefined) {
    context.addIssue({ code: 'custom', path: ['blockingReason'], message: '设计读取受阻时必须说明阻塞原因' });
  }
  if (catalog.analysisStatus === 'completed' && catalog.blockingReason !== undefined) {
    context.addIssue({ code: 'custom', path: ['blockingReason'], message: '设计分析完成时不能同时声明阻塞原因' });
  }
  const ids = new Set(catalog.assets.map((asset) => asset.id));
  if (ids.size !== catalog.assets.length) context.addIssue({ code: 'custom', path: ['assets'], message: '设计截图 ID 必须唯一' });
  const paths = new Set(catalog.assets.map((asset) => asset.imagePath));
  if (paths.size !== catalog.assets.length) context.addIssue({ code: 'custom', path: ['assets'], message: '设计截图路径必须唯一' });
});

export type FigmaDesignInput = z.infer<typeof FigmaDesignInputSchema>;
export type DesignReference = z.infer<typeof DesignReferenceSchema>;
export type DesignAssets = z.infer<typeof DesignAssetsSchema>;
