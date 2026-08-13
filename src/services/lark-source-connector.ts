import type { McpClient } from '../ports/mcp-client.js';
import type { McpServerConfigResolver } from '../ports/mcp-server-config-resolver.js';

export interface ConnectorSource {
  canonicalUrl: string;
  externalId: string;
  resolvedExternalId?: string;
  title?: string;
  markdown: string;
  fetchedAt: string;
  extractor: 'lark-mcp/v1';
}

export interface SourceConnector {
  supports(input: string): boolean;
  fetch(input: string): Promise<ConnectorSource>;
}

export interface LarkConnectorConfig {
  configPath: string;
  server: string;
  tool: string;
  useUAT: boolean;
}

export class LarkSourceConnectorError extends Error {
  constructor(readonly code: 'LARK_URL_UNSUPPORTED' | 'LARK_RESPONSE_INVALID' | 'LARK_MCP_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'LarkSourceConnectorError';
  }
}

export class LarkSourceConnector implements SourceConnector {
  constructor(
    private readonly deps: { client: McpClient; config: LarkConnectorConfig; resolver: McpServerConfigResolver },
  ) {}

  supports(input: string): boolean {
    return parseLarkUrl(input) !== undefined;
  }

  async fetch(input: string): Promise<ConnectorSource> {
    const parsed = parseLarkUrl(input);
    if (parsed === undefined) {
      throw new LarkSourceConnectorError('LARK_URL_UNSUPPORTED', '当前 Connector 不支持该文档类型');
    }

    try {
      const server = await this.deps.resolver.resolve({
        source: 'codex-toml',
        path: this.deps.config.configPath,
        server: this.deps.config.server,
      });
      const documentId = parsed.kind === 'docx' ? parsed.externalId : await this.resolveWikiDocument(server, parsed.externalId);
      const response = await this.deps.client.callTool({
        server,
        tool: this.deps.config.tool,
        arguments: documentArguments(documentId, this.deps.config.useUAT),
      });
      const markdown = contentFromResponse(response);
      return {
        canonicalUrl: parsed.canonicalUrl,
        externalId: parsed.externalId,
        ...(parsed.kind === 'wiki' ? { resolvedExternalId: documentId } : {}),
        fetchedAt: new Date().toISOString(),
        markdown,
        extractor: 'lark-mcp/v1',
      };
    } catch (error) {
      if (error instanceof LarkSourceConnectorError) {
        throw error;
      }
      throw new LarkSourceConnectorError('LARK_MCP_UNAVAILABLE', 'Lark MCP 不可用');
    }
  }

  private async resolveWikiDocument(server: Awaited<ReturnType<McpServerConfigResolver['resolve']>>, nodeToken: string): Promise<string> {
    const response = await this.deps.client.callTool({
      server,
      tool: 'wiki_v2_space_getNode',
      arguments: { params: { token: nodeToken }, useUAT: this.deps.config.useUAT },
    });
    const node = objectFromResponse(response)?.node;
    if (!isRecord(node) || node.obj_type !== 'docx' || typeof node.obj_token !== 'string' || node.obj_token.length === 0) {
      throw new LarkSourceConnectorError('LARK_URL_UNSUPPORTED', 'Wiki 节点不是可读取的 docx 文档');
    }
    return node.obj_token;
  }
}

function parseLarkUrl(input: string): { kind: 'docx' | 'wiki'; canonicalUrl: string; externalId: string } | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !isLarkHost(url.hostname)) {
    return undefined;
  }
  const match = /^\/(docx|wiki)\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  if (match === null) {
    return undefined;
  }
  return { kind: match[1] as 'docx' | 'wiki', canonicalUrl: `https://${url.host}/${match[1]}/${match[2]}`, externalId: match[2] };
}

function isLarkHost(hostname: string): boolean {
  return hostname.endsWith('.larksuite.com') || hostname.endsWith('.feishu.cn');
}

function contentFromResponse(response: unknown): string {
  const body = isRecord(response) && isRecord(response.data) && typeof response.data.content === 'string'
    ? response.data.content
    : objectFromResponse(response)?.content;
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', 'Lark MCP 返回了无效正文');
  }
  return body;
}

function documentArguments(documentId: string, useUAT: boolean): unknown {
  return { path: { document_id: documentId }, params: { lang: 0 }, useUAT };
}

function objectFromResponse(response: unknown): Record<string, unknown> | undefined {
  if (!isRecord(response) || !Array.isArray(response.content)) {
    return undefined;
  }
  const text = response.content.find((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string')?.text;
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
