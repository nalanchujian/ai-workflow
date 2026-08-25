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
  figmaUrl: z.string().url(),
  nodeId: z.string().regex(figmaNodeIdPattern, '必须是标准 Figma 节点 ID'),
  purpose: z.string().min(1),
}).strict();

const DesignCatalogItemSchema = z.object({
  figmaUrl: z.string().url(),
  nodeId: z.string().regex(figmaNodeIdPattern, '必须是标准 Figma 节点 ID'),
  title: z.string().min(1),
  kind: z.enum(['page', 'frame', 'dialog', 'component', 'state', 'other']),
  purpose: z.string().min(1),
  states: z.array(z.string().min(1)).default([]),
}).strict();

export const DesignCatalogSchema = z.object({
  schemaVersion: z.literal('aiw.design-catalog/v2'),
  source: FigmaDesignInputSchema,
  analysisStatus: z.enum(['completed', 'blocked']),
  blockingReason: z.string().min(1).optional(),
  items: z.array(DesignCatalogItemSchema).default([]),
}).strict().superRefine((catalog, context) => {
  if (catalog.analysisStatus === 'completed' && catalog.items.length === 0) {
    context.addIssue({ code: 'custom', path: ['items'], message: '设计分析完成时必须包含至少一个具体设计节点' });
  }
  if (catalog.analysisStatus === 'blocked' && catalog.blockingReason === undefined) {
    context.addIssue({ code: 'custom', path: ['blockingReason'], message: '设计读取受阻时必须说明阻塞原因' });
  }
  if (catalog.analysisStatus === 'completed' && catalog.blockingReason !== undefined) {
    context.addIssue({ code: 'custom', path: ['blockingReason'], message: '设计分析完成时不能同时声明阻塞原因' });
  }
});

export const DesignRulesSchema = z.object({
  schemaVersion: z.literal('aiw.design-rules/v1'),
  rules: z.array(z.object({
    category: z.enum(['layout', 'component', 'interaction', 'content', 'state']),
    statement: z.string().min(1),
    nodeIds: z.array(z.string().regex(figmaNodeIdPattern, '必须是标准 Figma 节点 ID')).default([]),
  }).strict()),
  openQuestions: z.array(z.object({
    question: z.string().min(1),
    background: z.string().min(1),
    impact: z.string().min(1),
    nodeId: z.string().regex(figmaNodeIdPattern, '必须是标准 Figma 节点 ID').optional(),
  }).strict()),
}).strict();

export type FigmaDesignInput = z.infer<typeof FigmaDesignInputSchema>;
export type DesignReference = z.infer<typeof DesignReferenceSchema>;
export type DesignCatalog = z.infer<typeof DesignCatalogSchema>;
export type DesignRules = z.infer<typeof DesignRulesSchema>;
