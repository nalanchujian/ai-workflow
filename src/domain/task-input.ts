import { z } from 'zod';

import { DesignImageInputSchema } from './design.js';
import { canonicalDocumentUrl, DocumentUrlSchema } from './document-url.js';

const LarkDocumentUrlSchema = DocumentUrlSchema.refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:'
    && (url.hostname.endsWith('.larksuite.com') || url.hostname.endsWith('.feishu.cn'))
    && /^\/(docx|wiki)\/[A-Za-z0-9]+\/?$/.test(url.pathname);
}, '需求文档只支持 Lark docx 或 wiki 地址');

const YapiDocumentUrlSchema = DocumentUrlSchema.refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 'yapi.hbdev.club'
    && /^\/project\/149\/interface\/api\/[1-9]\d*\/?$/.test(url.pathname);
}, '接口文档只支持当前 YApi 的文章地址');

export const RequirementSelectionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not-asked') }).strict(),
  z.object({ status: z.literal('provided'), url: LarkDocumentUrlSchema, section: z.string().trim().min(1).optional() }).strict(),
]);

export const ApiDocumentSelectionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not-asked') }).strict(),
  z.object({ status: z.literal('absent') }).strict(),
  z.object({ status: z.literal('provided'), urls: z.array(YapiDocumentUrlSchema).min(1) }).strict(),
]).superRefine((selection, context) => {
  if (selection.status !== 'provided') return;
  const valid = selection.urls.filter((url) => DocumentUrlSchema.safeParse(url).success);
  if (new Set(valid.map(canonicalDocumentUrl)).size !== valid.length) {
    context.addIssue({ code: 'custom', path: ['urls'], message: '接口文档 URL 不能重复' });
  }
});

export const DesignSelectionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not-asked') }).strict(),
  z.object({ status: z.literal('absent') }).strict(),
  z.object({ status: z.literal('provided'), image: DesignImageInputSchema }).strict(),
]);

export const TaskInputsSchema = z.object({
  requirement: RequirementSelectionSchema,
  apiDocuments: ApiDocumentSelectionSchema,
  design: DesignSelectionSchema,
}).strict();

export type TaskInputs = z.infer<typeof TaskInputsSchema>;
