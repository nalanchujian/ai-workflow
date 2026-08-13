import type { McpClient } from '../ports/mcp-client.js';
import type { McpServerConfigResolver } from '../ports/mcp-server-config-resolver.js';

export interface ConnectorSource {
  canonicalUrl: string;
  externalId: string;
  resolvedExternalId?: string;
  section?: { title: string; startBlockId: string; endBlockId: string };
  title?: string;
  markdown: string;
  fetchedAt: string;
  extractor: 'lark-mcp/v1';
}

export interface SourceConnector {
  supports(input: string): boolean;
  fetch(input: string, options?: { section?: string }): Promise<ConnectorSource>;
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

  async fetch(input: string, options: { section?: string } = {}): Promise<ConnectorSource> {
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
      const selected = options.section === undefined ? undefined : await this.readSection(server, documentId, options.section);
      const markdown = selected?.markdown ?? await this.readRawContent(server, documentId);
      return {
        canonicalUrl: parsed.canonicalUrl,
        externalId: parsed.externalId,
        ...(parsed.kind === 'wiki' ? { resolvedExternalId: documentId } : {}),
        ...(selected === undefined ? {} : { section: selected.section }),
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

  private async readRawContent(server: Awaited<ReturnType<McpServerConfigResolver['resolve']>>, documentId: string): Promise<string> {
    const response = await this.deps.client.callTool({
      server,
      tool: this.deps.config.tool,
      arguments: documentArguments(documentId, this.deps.config.useUAT),
    });
    return contentFromResponse(response);
  }

  private async readSection(
    server: Awaited<ReturnType<McpServerConfigResolver['resolve']>>,
    documentId: string,
    requestedTitle: string,
  ): Promise<{ markdown: string; section: { title: string; startBlockId: string; endBlockId: string } }> {
    const requested = normalizeHeading(requestedTitle);
    if (requested.length === 0) {
      throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', '需求章节不能为空');
    }
    const blocks: LarkBlock[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.deps.client.callTool({
        server,
        tool: 'docx_v1_documentBlock_list',
        arguments: blockArguments(documentId, this.deps.config.useUAT, pageToken),
      });
      const page = blocksPageFromResponse(response);
      blocks.push(...page.items);
      pageToken = page.hasMore ? page.nextPageToken : undefined;
    } while (pageToken !== undefined);

    const headings = blocks.flatMap((block, index) => block.headingLevel === undefined || block.text.length === 0
      ? []
      : [{ ...block, index }]);
    const matches = headings.filter((heading) => normalizeHeading(heading.text) === requested);
    if (matches.length === 0) {
      throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', `未找到需求章节：${requestedTitle.trim()}`);
    }
    if (matches.length > 1) {
      throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', `需求章节不唯一：${requestedTitle.trim()}`);
    }
    const heading = matches[0];
    const headingLevel = heading.headingLevel;
    if (headingLevel === undefined) {
      throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', 'Lark MCP 返回了无效章节标题');
    }
    const next = headings.find((candidate) => candidate.index > heading.index && candidate.headingLevel !== undefined && candidate.headingLevel <= headingLevel);
    const selected = blocks.slice(heading.index, next?.index).filter((block) => block.text.length > 0);
    const markdown = selected.map(renderBlock).join('\n\n').trim();
    if (selected.length <= 1 || markdown.replace(/^#{1,9}\s+.*(?:\n|$)/, '').trim().length === 0) {
      throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', `需求章节为空：${heading.text}`);
    }
    return {
      markdown,
      section: { title: heading.text, startBlockId: heading.id, endBlockId: selected.at(-1)?.id ?? heading.id },
    };
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

function blockArguments(documentId: string, useUAT: boolean, pageToken: string | undefined): unknown {
  return {
    path: { document_id: documentId },
    params: { document_revision_id: -1, page_size: 500, ...(pageToken === undefined ? {} : { page_token: pageToken }) },
    useUAT,
  };
}

interface LarkBlock {
  id: string;
  text: string;
  headingLevel?: number;
}

function blocksPageFromResponse(response: unknown): { hasMore: boolean; nextPageToken?: string; items: LarkBlock[] } {
  const body = objectFromResponse(response);
  if (!isRecord(body) || !Array.isArray(body.items) || typeof body.has_more !== 'boolean') {
    throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', 'Lark MCP 返回了无效文档块');
  }
  const items = body.items.map(normalizeBlock);
  const nextPageToken = typeof body.page_token === 'string' && body.page_token.length > 0 ? body.page_token : undefined;
  if (body.has_more && nextPageToken === undefined) {
    throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', 'Lark MCP 返回了无效文档块分页信息');
  }
  return { hasMore: body.has_more, ...(nextPageToken === undefined ? {} : { nextPageToken }), items };
}

function normalizeBlock(value: unknown): LarkBlock {
  if (!isRecord(value) || typeof value.block_id !== 'string' || value.block_id.length === 0) {
    throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', 'Lark MCP 返回了无效文档块');
  }
  const heading = Object.entries(value).find(([key, data]) => /^heading[1-9]$/.test(key) && isRecord(data));
  return {
    id: value.block_id,
    text: blockText(heading?.[1] ?? Object.values(value).find((data) => isRecord(data) && Array.isArray(data.elements))),
    ...(heading === undefined ? {} : { headingLevel: Number(heading[0].slice('heading'.length)) }),
  };
}

function blockText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.elements)) {
    return '';
  }
  return value.elements.flatMap((element) => {
    if (!isRecord(element)) {
      return [];
    }
    const textRun = isRecord(element.text_run) && typeof element.text_run.content === 'string' ? element.text_run.content : undefined;
    return textRun === undefined ? [] : [textRun];
  }).join('').trim();
}

function renderBlock(block: LarkBlock): string {
  return block.headingLevel === undefined ? block.text : `${'#'.repeat(block.headingLevel)} ${block.text}`;
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
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
