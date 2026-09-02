import type { NetworkClient } from '../ports/network-client.js';
import type { ConnectedDocumentSource, SourceConnector } from '../ports/source-connector.js';

export const YAPI_INTERFACE_DOCUMENT_BASE_URL = 'https://yapi.hbdev.club/project/149/interface/api/';
const YAPI_INTERFACE_API_URL = 'https://yapi.hbdev.club/api/interface/get?id=';

export class YapiSourceConnectorError extends Error {
  constructor(readonly code: 'YAPI_ID_INVALID' | 'YAPI_URL_UNSUPPORTED' | 'YAPI_UNAVAILABLE' | 'YAPI_RESPONSE_INVALID', message: string) {
    super(message);
    this.name = 'YapiSourceConnectorError';
  }
}

export function parseYapiDocumentIds(values: string[]): string[] {
  const ids = values.flatMap((value) => value.split(/[\s,，]+/)).map((value) => value.trim()).filter(Boolean);
  for (const id of ids) {
    if (!/^[1-9]\d*$/.test(id)) {
      throw new YapiSourceConnectorError('YAPI_ID_INVALID', `API 文档 ID 无效：${id}。请输入文档链接末尾的正整数 ID，多个 ID 可用逗号分隔或重复使用 --api-doc-id。`);
    }
  }
  return [...new Set(ids)];
}

export function yapiInterfaceDocumentUrl(id: string): string {
  if (!/^[1-9]\d*$/.test(id)) {
    throw new YapiSourceConnectorError('YAPI_ID_INVALID', `API 文档 ID 无效：${id}`);
  }
  return `${YAPI_INTERFACE_DOCUMENT_BASE_URL}${id}`;
}

export class YapiSourceConnector implements SourceConnector {
  constructor(private readonly deps: { network: NetworkClient }) {}

  supports(reference: string): boolean {
    return parseInterfaceId(reference) !== undefined;
  }

  async fetch(reference: string): Promise<ConnectedDocumentSource> {
    const id = parseInterfaceId(reference);
    if (id === undefined) {
      throw new YapiSourceConnectorError('YAPI_URL_UNSUPPORTED', '仅支持当前 YApi 项目中的接口文档链接');
    }
    let response;
    try {
      response = await this.deps.network.fetch({ url: `${YAPI_INTERFACE_API_URL}${id}`, timeoutMs: 15_000 });
    } catch (error) {
      throw new YapiSourceConnectorError('YAPI_UNAVAILABLE', `无法读取 YApi 接口文档 ${id}: ${error instanceof Error ? error.message : '网络请求失败'}`);
    }
    if (response.status !== undefined && (response.status < 200 || response.status >= 300)) {
      throw new YapiSourceConnectorError('YAPI_UNAVAILABLE', `读取 YApi 接口文档 ${id} 失败（HTTP ${response.status}）`);
    }
    const payload = parsePayload(response.body, id);
    if (payload.errcode !== 0 || payload.data === undefined || payload.data === null || typeof payload.data !== 'object') {
      const detail = typeof payload.errmsg === 'string' && payload.errmsg.length > 0 ? `：${payload.errmsg}` : '';
      throw new YapiSourceConnectorError('YAPI_UNAVAILABLE', `读取 YApi 接口文档 ${id} 失败${detail}`);
    }
    const api = payload.data as YapiInterface;
    return {
      canonicalUrl: yapiInterfaceDocumentUrl(id),
      externalId: id,
      title: stringValue(api.title) || `YApi 接口 ${id}`,
      markdown: renderInterfaceDocument(id, api),
      fetchedAt: new Date().toISOString(),
      extractor: 'yapi-interface-api/v1',
    };
  }
}

type YapiPayload = { errcode?: unknown; errmsg?: unknown; data?: unknown };
type YapiField = { name?: unknown; value?: unknown; required?: unknown; desc?: unknown; example?: unknown };
type YapiInterface = {
  title?: unknown;
  method?: unknown;
  path?: unknown;
  desc?: unknown;
  req_headers?: unknown;
  req_query?: unknown;
  req_params?: unknown;
  req_body_type?: unknown;
  req_body_form?: unknown;
  req_body_other?: unknown;
  res_body_type?: unknown;
  res_body?: unknown;
};

function parseInterfaceId(reference: string): string | undefined {
  let url: URL;
  try { url = new URL(reference); } catch { return undefined; }
  const match = /^\/project\/149\/interface\/api\/([1-9]\d*)\/?$/.exec(url.pathname);
  return url.protocol === 'https:' && url.hostname === 'yapi.hbdev.club' && url.port === '' && !url.username && !url.password && match !== null ? match[1] : undefined;
}

function parsePayload(body: string, id: string): YapiPayload {
  try {
    const payload = JSON.parse(body) as YapiPayload;
    if (typeof payload !== 'object' || payload === null) throw new Error('not an object');
    return payload;
  } catch {
    throw new YapiSourceConnectorError('YAPI_RESPONSE_INVALID', `YApi 接口文档 ${id} 返回了无效数据`);
  }
}

function renderInterfaceDocument(id: string, api: YapiInterface): string {
  const title = stringValue(api.title) || `YApi 接口 ${id}`;
  const method = stringValue(api.method).toUpperCase() || 'UNKNOWN';
  const path = stringValue(api.path) || '/';
  const sections = [
    `# ${title}`,
    '',
    `- 文档 ID: ${id}`,
    `- 请求: \`${method} ${path}\``,
  ];
  const description = stringValue(api.desc);
  if (description) sections.push('', '## 说明', '', description);
  appendFields(sections, '请求头', api.req_headers);
  appendFields(sections, '查询参数', api.req_query);
  appendFields(sections, '路径参数', api.req_params);
  appendRequestBody(sections, api);
  appendCode(sections, '响应示例', api.res_body, stringValue(api.res_body_type));
  return `${sections.join('\n').trim()}\n`;
}

function appendFields(sections: string[], title: string, value: unknown): void {
  const fields = Array.isArray(value) ? value.filter(isRecord).map((field) => field as YapiField) : [];
  if (fields.length === 0) return;
  sections.push('', `## ${title}`, '', '| 名称 | 必填 | 示例/值 | 说明 |', '| --- | --- | --- | --- |');
  for (const field of fields) {
    sections.push(`| ${tableCell(field.name)} | ${requiredCell(field.required)} | ${tableCell(field.example ?? field.value)} | ${tableCell(field.desc)} |`);
  }
}

function appendRequestBody(sections: string[], api: YapiInterface): void {
  const forms = Array.isArray(api.req_body_form) ? api.req_body_form : [];
  if (forms.length > 0) {
    appendFields(sections, '请求体（表单）', forms);
    return;
  }
  appendCode(sections, '请求体', api.req_body_other, stringValue(api.req_body_type));
}

function appendCode(sections: string[], title: string, body: unknown, type: string): void {
  const content = stringValue(body);
  if (!content) return;
  const language = type.toLocaleLowerCase().includes('json') || looksLikeJson(content) ? 'json' : '';
  sections.push('', `## ${title}`, '', `\`\`\`${language}`, content, '```');
}

function looksLikeJson(value: string): boolean {
  return /^\s*[{[]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
}

function tableCell(value: unknown): string {
  return stringValue(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function requiredCell(value: unknown): string {
  return value === '1' || value === 1 || value === true ? '是' : '否';
}
