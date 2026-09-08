import { z } from 'zod';

import { DesignImageInputSchema } from './design.js';
import { canonicalDocumentUrl, DocumentUrlSchema } from './document-url.js';

export const ApiDocumentSelectionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not-asked') }).strict(),
  z.object({ status: z.literal('absent') }).strict(),
  z.object({ status: z.literal('provided'), urls: z.array(DocumentUrlSchema).min(1) }).strict(),
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
  requirementUrl: DocumentUrlSchema,
  apiDocuments: ApiDocumentSelectionSchema,
  design: DesignSelectionSchema,
}).strict();

export type TaskInputs = z.infer<typeof TaskInputsSchema>;
