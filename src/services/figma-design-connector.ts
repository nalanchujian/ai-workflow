import type { McpClient } from '../ports/mcp-client.js';
import type { McpServerConfigResolver } from '../ports/mcp-server-config-resolver.js';
import type { CapturedDesignNode, CapturedDesignRoot, DesignConnector } from '../ports/design-connector.js';

export interface FigmaConnectorConfig {
  configPath: string;
  server: string;
  tools: {
    metadata: string;
    screenshot: string;
    designContext: string;
  };
}

export class FigmaDesignConnectorError extends Error {
  constructor(readonly code: 'FIGMA_URL_UNSUPPORTED' | 'FIGMA_RESPONSE_INVALID' | 'FIGMA_MCP_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'FigmaDesignConnectorError';
  }
}

export class FigmaDesignConnector implements DesignConnector {
  constructor(private readonly deps: {
    client: McpClient;
    resolver: McpServerConfigResolver;
    config: FigmaConnectorConfig;
  }) {}

  supports(url: string): boolean {
    return parseFigmaDesignUrl(url) !== undefined;
  }

  async captureRoot(input: { url: string }): Promise<CapturedDesignRoot> {
    const parsed = parseFigmaDesignUrl(input.url);
    if (parsed === undefined) {
      throw new FigmaDesignConnectorError('FIGMA_URL_UNSUPPORTED', '当前仅支持带 node-id 的 Figma Design 地址');
    }
    try {
      const server = await this.server();
      const arguments_ = { fileKey: parsed.fileKey, nodeId: parsed.nodeId };
      const metadata = textFromResponse(await this.deps.client.callTool({
        server, tool: this.deps.config.tools.metadata, arguments: arguments_,
      }));
      const screenshot = pngFromResponse(await this.deps.client.callTool({
        server, tool: this.deps.config.tools.screenshot, arguments: arguments_,
      }));
      return { ...parsed, metadata, screenshot, capturedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof FigmaDesignConnectorError) throw error;
      throw new FigmaDesignConnectorError('FIGMA_MCP_UNAVAILABLE', 'Figma MCP 不可用');
    }
  }

  async captureNode(input: { url: string; nodeId: string }): Promise<CapturedDesignNode> {
    const parsed = parseFigmaDesignUrl(input.url);
    if (parsed === undefined || !/^\d+:\d+$/.test(input.nodeId)) {
      throw new FigmaDesignConnectorError('FIGMA_URL_UNSUPPORTED', 'Figma 设计节点地址无效');
    }
    try {
      const server = await this.server();
      const arguments_ = { fileKey: parsed.fileKey, nodeId: input.nodeId };
      const designContext = textFromResponse(await this.deps.client.callTool({
        server, tool: this.deps.config.tools.designContext, arguments: arguments_,
      }));
      const screenshot = pngFromResponse(await this.deps.client.callTool({
        server, tool: this.deps.config.tools.screenshot, arguments: arguments_,
      }));
      return { designContext, screenshot };
    } catch (error) {
      if (error instanceof FigmaDesignConnectorError) throw error;
      throw new FigmaDesignConnectorError('FIGMA_MCP_UNAVAILABLE', 'Figma MCP 不可用');
    }
  }

  private server() {
    return this.deps.resolver.resolve({
      source: 'codex-toml', path: this.deps.config.configPath, server: this.deps.config.server,
    });
  }
}

export function parseFigmaDesignUrl(input: string): { fileKey: string; nodeId: string } | undefined {
  let url: URL;
  try { url = new URL(input); } catch { return undefined; }
  if (url.protocol !== 'https:' || !['figma.com', 'www.figma.com'].includes(url.hostname)) return undefined;
  const match = /^\/(?:design|file)\/([^/]+)\/.+/.exec(url.pathname);
  const rawNodeId = url.searchParams.get('node-id');
  if (match === null || rawNodeId === null || !/^\d+(?:-|:)\d+$/.test(rawNodeId)) return undefined;
  return { fileKey: match[1], nodeId: rawNodeId.replace('-', ':') };
}

function textFromResponse(response: unknown): string {
  const content = contentBlocks(response);
  const text = content
    .filter((block): block is Record<string, unknown> & { text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (text.length === 0) throw new FigmaDesignConnectorError('FIGMA_RESPONSE_INVALID', 'Figma MCP 未返回可读文本');
  return text;
}

function pngFromResponse(response: unknown): Buffer {
  const image = contentBlocks(response).find((block) => block.type === 'image' && block.mimeType === 'image/png' && typeof block.data === 'string');
  if (image === undefined || typeof image.data !== 'string') {
    throw new FigmaDesignConnectorError('FIGMA_RESPONSE_INVALID', 'Figma MCP 未返回 PNG 截图');
  }
  const data = Buffer.from(image.data, 'base64');
  if (data.length === 0) throw new FigmaDesignConnectorError('FIGMA_RESPONSE_INVALID', 'Figma MCP 返回了空截图');
  return data;
}

function contentBlocks(response: unknown): Record<string, unknown>[] {
  if (typeof response !== 'object' || response === null || !('content' in response) || !Array.isArray(response.content)) {
    throw new FigmaDesignConnectorError('FIGMA_RESPONSE_INVALID', 'Figma MCP 返回格式无效');
  }
  return response.content.filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null);
}
