import type { NetworkClient } from '../ports/network-client.js';
import type { ConnectedDocumentSource, SourceConnector } from '../ports/source-connector.js';
import {
  LarkSourceConnectorError,
  larkBlocksPageFromResponse,
  parseLarkUrl,
  renderLarkBlocks,
  selectLarkSection,
  type LarkBlock,
} from './lark-source-connector.js';

export interface LarkOpenApiConfig {
  appId: string;
  appSecret: string;
  domain: string;
}

/** Reads Lark Wiki and Docx documents through Lark OpenAPI with app credentials. */
export class LarkOpenApiSourceConnector implements SourceConnector {
  constructor(private readonly deps: { network: NetworkClient; config: LarkOpenApiConfig }) {}

  supports(input: string): boolean {
    return parseLarkUrl(input) !== undefined;
  }

  async fetch(input: string, options: { section?: string } = {}): Promise<ConnectedDocumentSource> {
    const parsed = parseLarkUrl(input);
    if (parsed === undefined) {
      throw new LarkSourceConnectorError('LARK_URL_UNSUPPORTED', '当前连接器不支持该文档类型');
    }
    try {
      const accessToken = await this.tenantAccessToken();
      const documentId = parsed.kind === 'wiki' ? await this.resolveWikiDocument(parsed.externalId, accessToken) : parsed.externalId;
      const blocks = await this.readBlocks(documentId, accessToken);
      const selected = options.section === undefined ? undefined : selectLarkSection(blocks, options.section);
      const markdown = selected?.markdown ?? renderLarkBlocks(blocks);
      if (markdown.trim().length === 0) {
        throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', 'Lark OpenAPI 返回了空文档');
      }
      return {
        canonicalUrl: parsed.canonicalUrl,
        externalId: parsed.externalId,
        ...(parsed.kind === 'wiki' ? { resolvedExternalId: documentId } : {}),
        ...(selected === undefined ? {} : { section: selected.section }),
        fetchedAt: new Date().toISOString(),
        markdown,
        extractor: 'lark-openapi/v1',
      };
    } catch (error) {
      if (error instanceof LarkSourceConnectorError) {
        throw error;
      }
      throw new LarkSourceConnectorError('LARK_MCP_UNAVAILABLE', 'Lark OpenAPI 不可用');
    }
  }

  private async tenantAccessToken(): Promise<string> {
    const body = await this.request('/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.deps.config.appId, app_secret: this.deps.config.appSecret }),
      topLevel: true,
    });
    if (typeof body.tenant_access_token !== 'string' || body.tenant_access_token.length === 0) {
      throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', 'Lark OpenAPI 未返回应用令牌');
    }
    return body.tenant_access_token;
  }

  private async resolveWikiDocument(nodeToken: string, accessToken: string): Promise<string> {
    const body = await this.request(`/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}`, { accessToken });
    const node = body.node;
    if (!isRecord(node) || node.obj_type !== 'docx' || typeof node.obj_token !== 'string' || node.obj_token.length === 0) {
      throw new LarkSourceConnectorError('LARK_URL_UNSUPPORTED', 'Wiki 节点不是可读取的 docx 文档');
    }
    return node.obj_token;
  }

  private async readBlocks(documentId: string, accessToken: string): Promise<LarkBlock[]> {
    const blocks: LarkBlock[] = [];
    let pageToken: string | undefined;
    do {
      const parameters = new URLSearchParams({ document_revision_id: '-1', page_size: '500' });
      if (pageToken !== undefined) parameters.set('page_token', pageToken);
      const body = await this.request(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?${parameters.toString()}`, { accessToken });
      const page = larkBlocksPageFromResponse(body);
      blocks.push(...page.items);
      pageToken = page.hasMore ? page.nextPageToken : undefined;
    } while (pageToken !== undefined);
    return blocks;
  }

  private async request(path: string, input: { accessToken?: string; method?: 'POST'; headers?: Record<string, string>; body?: string; topLevel?: boolean } = {}): Promise<Record<string, unknown>> {
    const url = `${this.apiBase()}${path}`;
    let response;
    try {
      response = await this.deps.network.fetch({
        url,
        timeoutMs: 30_000,
        ...(input.method === undefined ? {} : { method: input.method }),
        headers: {
          ...(input.headers ?? {}),
          ...(input.accessToken === undefined ? {} : { authorization: `Bearer ${input.accessToken}` }),
        },
        ...(input.body === undefined ? {} : { body: input.body }),
      });
    } catch {
      throw new LarkSourceConnectorError('LARK_MCP_UNAVAILABLE', 'Lark OpenAPI 不可用');
    }
    const envelope = parseEnvelope(response.body);
    if (response.status !== 200 || envelope.code !== 0 || (!input.topLevel && !isRecord(envelope.data))) {
      if (envelope.code === 99991672) {
        throw new LarkSourceConnectorError('LARK_AUTHORIZATION_DENIED', 'Lark OpenAPI 缺少 Wiki 读取权限，请在应用中授权、发布并完成审批');
      }
      throw new LarkSourceConnectorError('LARK_MCP_UNAVAILABLE', 'Lark OpenAPI 不可用');
    }
    return input.topLevel ? envelope.raw : envelope.data as Record<string, unknown>;
  }

  private apiBase(): string {
    return this.deps.config.domain.replace(/\/$/, '');
  }
}

function parseEnvelope(input: string): { code?: number; data?: unknown; raw: Record<string, unknown> } {
  try {
    const parsed: unknown = JSON.parse(input);
    return isRecord(parsed) ? { code: typeof parsed.code === 'number' ? parsed.code : undefined, data: parsed.data, raw: parsed } : { raw: {} };
  } catch {
    return { raw: {} };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
