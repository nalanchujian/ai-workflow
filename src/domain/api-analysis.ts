import { z } from 'zod';
import { canonicalDocumentUrl, DocumentUrlSchema } from './document-url.js';

const id = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, '接口标识必须使用英文 kebab-case');
const snapshotPath = z.string().regex(/^sources\/api\/[a-z][a-z0-9-]*\/(?:r[1-9][0-9]*\/)?snapshot\.md$/, '接口快照必须位于 sources/api/');

export const ApiReferenceSchema = z.object({ apiId: id }).strict();
export const ResolvedApiReferenceSchema = ApiReferenceSchema.extend({
  documentId: id,
  snapshotPath,
}).strict();

export const ApiInterfaceSchema = z.object({
  id,
  title: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT']).nullable(),
  path: z.string().startsWith('/').nullable(),
  request: z.string().min(1),
  response: z.string().min(1),
  errors: z.array(z.string().min(1)),
  constraints: z.array(z.string().min(1)),
  missingInformation: z.array(z.string().min(1)),
}).strict().superRefine((api, context) => {
  if ((api.method === null || api.path === null) && api.missingInformation.length === 0) {
    context.addIssue({ code: 'custom', path: ['missingInformation'], message: '接口方法或路径缺失时必须记录缺失信息' });
  }
});

export const ApiAnalysisSchema = z.object({
  schemaVersion: z.literal('aiw.api-analysis/v1'),
  documents: z.array(z.object({
    id, url: DocumentUrlSchema, snapshotPath,
    interfaces: z.array(ApiInterfaceSchema),
    missingInformation: z.array(z.string().min(1)),
  }).strict().superRefine((document, context) => {
    if (document.interfaces.length === 0 && document.missingInformation.length === 0) {
      context.addIssue({ code: 'custom', path: ['missingInformation'], message: '文档没有可识别接口时必须记录缺失信息' });
    }
  })).min(1),
}).strict().superRefine((analysis, context) => {
  const ids = new Set<string>();
  const urls = new Set<string>();
  const paths = new Set<string>();
  const apiIds = new Set<string>();
  analysis.documents.forEach((document, index) => {
    for (const [field, value, seen] of [
      ['id', document.id, ids], ['url', DocumentUrlSchema.safeParse(document.url).success ? canonicalDocumentUrl(document.url) : document.url, urls], ['snapshotPath', document.snapshotPath, paths],
    ] as const) {
      if (seen.has(value)) context.addIssue({ code: 'custom', path: ['documents', index, field], message: '接口文档标识、URL 和快照路径必须唯一' });
      seen.add(value);
    }
    document.interfaces.forEach((api, apiIndex) => {
      if (apiIds.has(api.id)) context.addIssue({ code: 'custom', path: ['documents', index, 'interfaces', apiIndex, 'id'], message: '接口 ID 必须全局唯一' });
      apiIds.add(api.id);
    });
  });
});

export type ApiAnalysis = z.infer<typeof ApiAnalysisSchema>;

/** The task stores URLs only; these deterministic IDs make their snapshots auditable. */
export function selectedApiDocuments(urls: string[]): Array<{ id: string; url: string; sourceId: string }> {
  return urls.map((url, index) => {
    const canonicalUrl = canonicalDocumentUrl(DocumentUrlSchema.parse(url));
    const id = `api-document-${index + 1}`;
    return { id, url: canonicalUrl, sourceId: `api/${id}` };
  });
}
