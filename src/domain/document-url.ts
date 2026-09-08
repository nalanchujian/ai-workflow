import { z } from 'zod';

/** A document address, never a local path, interface ID or business API request. */
export const DocumentUrlSchema = z.string().url('必须提供完整文档 URL').refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, '文档地址只支持不含凭据的 HTTP(S) URL');

export function canonicalDocumentUrl(value: string): string {
  return new URL(value).href;
}
