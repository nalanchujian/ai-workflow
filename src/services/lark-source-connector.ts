import type { McpClient } from '../ports/mcp-client.js';
import type { McpServerConfigResolver } from '../ports/mcp-server-config-resolver.js';

export interface ConnectorSource {
  canonicalUrl: string;
  externalId: string;
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
    return parseDocumentUrl(input) !== undefined;
  }

  async fetch(input: string): Promise<ConnectorSource> {
    const parsed = parseDocumentUrl(input);
    if (parsed === undefined) {
      throw new LarkSourceConnectorError('LARK_URL_UNSUPPORTED', '当前 Connector 不支持该文档类型');
    }

    try {
      const server = await this.deps.resolver.resolve({
        source: 'codex-toml',
        path: this.deps.config.configPath,
        server: this.deps.config.server,
      });
      const response = await this.deps.client.callTool({
        server,
        tool: this.deps.config.tool,
        arguments: {
          path: { document_id: parsed.externalId },
          params: { lang: 0 },
          useUAT: this.deps.config.useUAT,
        },
      });
      const markdown = contentFromResponse(response);
      return {
        canonicalUrl: parsed.canonicalUrl,
        externalId: parsed.externalId,
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
}

function parseDocumentUrl(input: string): { canonicalUrl: string; externalId: string } | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.(larksuite\.com|feishu\.cn)$/i.test(url.hostname)) {
    return undefined;
  }
  const match = /^\/docx\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  if (match === null) {
    return undefined;
  }
  return { canonicalUrl: `https://${url.host}/docx/${match[1]}`, externalId: match[1] };
}

function contentFromResponse(response: unknown): string {
  if (
    typeof response !== 'object' || response === null ||
    !('data' in response) || typeof response.data !== 'object' || response.data === null ||
    !('content' in response.data) || typeof response.data.content !== 'string' ||
    response.data.content.trim().length === 0
  ) {
    throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', 'Lark MCP 返回了无效正文');
  }
  return response.data.content;
}
