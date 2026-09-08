import type { McpClient } from '../ports/mcp-client.js';
import type { McpServerConfigResolver } from '../ports/mcp-server-config-resolver.js';
import type { ConnectedDocumentSource, SourceConnector } from '../ports/source-connector.js';

export interface LarkConnectorConfig {
  configPath: string;
  server: string;
  tool: string;
  useUAT: boolean;
}

export class LarkSourceConnectorError extends Error {
  constructor(readonly code: 'LARK_URL_UNSUPPORTED' | 'LARK_RESPONSE_INVALID' | 'LARK_MCP_UNAVAILABLE' | 'LARK_AUTH_EXPIRED' | 'LARK_AUTHORIZATION_DENIED', message: string) {
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

  async fetch(input: string, options: { section?: string } = {}): Promise<ConnectedDocumentSource> {
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
    const response = await this.callTool({
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
    const blocks: LarkBlock[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.callTool({
        server,
        tool: 'docx_v1_documentBlock_list',
        arguments: blockArguments(documentId, this.deps.config.useUAT, pageToken),
      });
      const page = larkBlocksPageFromResponse(response);
      blocks.push(...page.items);
      pageToken = page.hasMore ? page.nextPageToken : undefined;
    } while (pageToken !== undefined);

    return selectLarkSection(blocks, requestedTitle);
  }

  private async resolveWikiDocument(server: Awaited<ReturnType<McpServerConfigResolver['resolve']>>, nodeToken: string): Promise<string> {
    const response = await this.callTool({
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

  private async callTool(input: { server: Awaited<ReturnType<McpServerConfigResolver['resolve']>>; tool: string; arguments: unknown }): Promise<unknown> {
    const response = await this.deps.client.callTool(input);
    const message = mcpErrorMessage(response);
    if (message === undefined) {
      return response;
    }
    if (/user_access_token is invalid or expired/i.test(message)) {
      throw new LarkSourceConnectorError('LARK_AUTH_EXPIRED', 'Lark Connector 登录状态已失效，请重新授权后重试');
    }
    throw new LarkSourceConnectorError('LARK_MCP_UNAVAILABLE', 'Lark MCP 不可用');
  }
}

export function isLarkDocumentReference(input: string): boolean {
  return parseLarkUrl(input) !== undefined;
}

export function parseLarkUrl(input: string): { kind: 'docx' | 'wiki'; canonicalUrl: string; externalId: string } | undefined {
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

export interface LarkBlock {
  id: string;
  kind: string;
  text: string;
  headingLevel?: number;
  parentId?: string;
  children: string[];
  tableCells: string[];
  tableColumnCount?: number;
  imageToken?: string;
}

export function larkBlocksPageFromResponse(response: unknown): { hasMore: boolean; nextPageToken?: string; items: LarkBlock[] } {
  const body = isRecord(response) && Array.isArray(response.content) ? objectFromResponse(response) : isRecord(response) ? response : undefined;
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
  const data = blockData(value);
  const heading = /^heading([1-9])$/.exec(data.kind);
  const table = data.kind === 'table' && isRecord(data.value) ? data.value : undefined;
  const property = table === undefined ? undefined : isRecord(table.property) ? table.property : undefined;
  return {
    id: value.block_id,
    kind: data.kind,
    text: richText(data.value),
    ...(heading === null ? {} : { headingLevel: Number(heading[1]) }),
    ...(typeof value.parent_id === 'string' && value.parent_id.length > 0 ? { parentId: value.parent_id } : {}),
    children: stringArray(value.children),
    tableCells: table === undefined ? [] : stringArray(table.cells).length > 0 ? stringArray(table.cells) : stringArray(value.children),
    ...(property !== undefined && positiveInteger(property.column_size) !== undefined ? { tableColumnCount: positiveInteger(property.column_size) } : {}),
    ...(imageToken(data.value) === undefined ? {} : { imageToken: imageToken(data.value) }),
  };
}

function blockData(value: Record<string, unknown>): { kind: string; value: unknown } {
  const heading = Object.entries(value).find(([key, data]) => /^heading[1-9]$/.test(key) && isRecord(data));
  if (heading !== undefined) {
    return { kind: heading[0], value: heading[1] };
  }
  const supported = ['page', 'text', 'bullet', 'ordered', 'code', 'quote', 'todo', 'callout', 'table', 'table_cell', 'divider', 'image', 'file'];
  const direct = supported.find((key) => isRecord(value[key]));
  if (direct !== undefined) {
    return { kind: direct, value: value[direct] };
  }
  return { kind: 'unsupported', value: undefined };
}

function richText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.elements)) {
    return '';
  }
  return value.elements.flatMap((element) => {
    if (!isRecord(element)) {
      return [];
    }
    if (isRecord(element.text_run) && typeof element.text_run.content === 'string') {
      return [renderTextRun(element.text_run)];
    }
    if (isRecord(element.mention_doc) && typeof element.mention_doc.title === 'string') {
      return [`[${element.mention_doc.title}](lark-doc://${String(element.mention_doc.token ?? '')})`];
    }
    if (isRecord(element.equation) && typeof element.equation.content === 'string') {
      return [`$${element.equation.content}$`];
    }
    return [];
  }).join('').trim();
}

function renderTextRun(textRun: Record<string, unknown>): string {
  let text = textRun.content as string;
  const style = isRecord(textRun.text_element_style) ? textRun.text_element_style : isRecord(textRun.style) ? textRun.style : undefined;
  if (style === undefined) {
    return text;
  }
  if (style.code_inline === true || style.codeInline === true) {
    text = `\`${text}\``;
  }
  if (style.bold === true) {
    text = `**${text}**`;
  }
  if (style.italic === true) {
    text = `*${text}*`;
  }
  if (style.strikethrough === true || style.strike_through === true || style.strikeThrough === true) {
    text = `~~${text}~~`;
  }
  const link = isRecord(style.link) && typeof style.link.url === 'string' ? style.link.url : undefined;
  return link === undefined ? text : `[${text}](${decodeURIComponent(link)})`;
}

export function renderLarkBlocks(blocks: LarkBlock[]): string {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const consumed = new Set<string>();
  const parts = blocks.flatMap((block) => {
    if (consumed.has(block.id) || block.kind === 'table_cell' || block.kind === 'page' || block.kind === 'unsupported') {
      return [];
    }
    if (block.kind === 'table') {
      collectTableContents(block, byId, consumed);
      const table = renderTable(block, byId);
      return table.length === 0 ? [] : [table];
    }
    const markdown = renderBlock(block, byId);
    return markdown.length === 0 ? [] : [markdown];
  });
  return parts.join('\n\n').trim();
}

export function selectLarkSection(blocks: LarkBlock[], requestedTitle: string): { markdown: string; section: { title: string; startBlockId: string; endBlockId: string } } {
  const requested = normalizeHeading(requestedTitle);
  if (requested.length === 0) {
    throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', '需求章节不能为空');
  }
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
    throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', 'Lark 文档返回了无效章节标题');
  }
  const next = headings.find((candidate) => candidate.index > heading.index && candidate.headingLevel !== undefined && candidate.headingLevel <= headingLevel);
  const selected = blocks.slice(heading.index, next?.index);
  const markdown = renderLarkBlocks(selected);
  if (selected.length <= 1 || markdown.replace(/^#{1,9}\s+.*(?:\n|$)/, '').trim().length === 0) {
    throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', `需求章节为空：${heading.text}`);
  }
  return {
    markdown,
    section: { title: heading.text, startBlockId: heading.id, endBlockId: selected.at(-1)?.id ?? heading.id },
  };
}

function renderBlock(block: LarkBlock, byId: Map<string, LarkBlock>): string {
  if (block.headingLevel !== undefined) {
    return `${'#'.repeat(block.headingLevel)} ${block.text}`;
  }
  switch (block.kind) {
    case 'bullet':
      return `${listIndentation(block, byId)}- ${block.text}`;
    case 'ordered':
      return `${listIndentation(block, byId)}1. ${block.text}`;
    case 'todo':
      return `${listIndentation(block, byId)}- [ ] ${block.text}`;
    case 'quote':
      return `> ${block.text}`;
    case 'code':
      return `\`\`\`\n${block.text}\n\`\`\``;
    case 'divider':
      return '---';
    case 'image':
      return block.imageToken === undefined ? '[Lark 图片]' : `![Lark 图片（${block.imageToken}）](lark-image://${block.imageToken})`;
    case 'file':
      return block.text.length === 0 ? '[Lark 附件]' : `[Lark 附件：${block.text}]`;
    default:
      return block.text;
  }
}

function listIndentation(block: LarkBlock, byId: Map<string, LarkBlock>): string {
  let parent = block.parentId === undefined ? undefined : byId.get(block.parentId);
  let depth = 0;
  while (parent !== undefined) {
    if (['bullet', 'ordered', 'todo'].includes(parent.kind)) {
      depth += 1;
    }
    parent = parent.parentId === undefined ? undefined : byId.get(parent.parentId);
  }
  return '  '.repeat(depth);
}

function collectTableContents(block: LarkBlock, byId: Map<string, LarkBlock>, consumed: Set<string>): void {
  for (const cellId of block.tableCells) {
    collectDescendants(cellId, byId, consumed);
  }
}

function collectDescendants(id: string, byId: Map<string, LarkBlock>, consumed: Set<string>): void {
  if (consumed.has(id)) {
    return;
  }
  consumed.add(id);
  const block = byId.get(id);
  if (block !== undefined) {
    for (const childId of block.children) {
      collectDescendants(childId, byId, consumed);
    }
  }
}

function renderTable(table: LarkBlock, byId: Map<string, LarkBlock>): string {
  const columns = table.tableColumnCount ?? table.tableCells.length;
  if (columns === 0 || table.tableCells.length === 0 || table.tableCells.length % columns !== 0) {
    return table.text;
  }
  const cells = table.tableCells.map((cellId) => renderTableCell(cellId, byId));
  const rows = Array.from({ length: cells.length / columns }, (_, index) => cells.slice(index * columns, (index + 1) * columns));
  const [header, ...body] = rows;
  if (body.some((row) => row.some((cell) => cell.isBlockContent))) {
    return renderStructuredTable(header, body);
  }
  return [
    `| ${header.map((cell) => escapeTableCell(cell.markdown)).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.map((cell) => escapeTableCell(cell.markdown)).join(' | ')} |`),
  ].join('\n');
}

interface RenderedTableCell {
  markdown: string;
  isBlockContent: boolean;
}

function renderTableCell(cellId: string, byId: Map<string, LarkBlock>): RenderedTableCell {
  const cell = byId.get(cellId);
  if (cell === undefined) {
    return { markdown: '', isBlockContent: false };
  }
  const blocks = cell.children.flatMap((childId) => renderBlockTree(childId, byId));
  return {
    markdown: blocks.map((block) => block.markdown).join('\n\n').trim(),
    isBlockContent: blocks.some((block) => block.isBlockContent),
  };
}

function renderBlockTree(id: string, byId: Map<string, LarkBlock>): RenderedTableCell[] {
  const block = byId.get(id);
  if (block === undefined) {
    return [];
  }
  const own = renderBlock(block, byId);
  const children = block.children.flatMap((childId) => renderBlockTree(childId, byId));
  if (children.length === 0) {
    return own.length === 0 ? [] : [{ markdown: own, isBlockContent: isBlockType(block) }];
  }
  const content = own.length === 0
    ? children.map((child) => child.markdown).join('\n\n')
    : `${own}${isListType(block) ? '\n' : '\n\n'}${children.map((child) => child.markdown).join('\n\n')}`;
  return [{ markdown: content, isBlockContent: isBlockType(block) || children.some((child) => child.isBlockContent) }];
}

function renderStructuredTable(header: RenderedTableCell[], body: RenderedTableCell[][]): string {
  const labels = header.map((cell, index) => plainText(cell.markdown) || `列 ${index + 1}`);
  return body.map((row, rowIndex) => {
    const title = plainText(row[0]?.markdown ?? '') || `第 ${rowIndex + 1} 项`;
    const sections = row.slice(1).flatMap((cell, index) => {
      if (cell.markdown.length === 0) {
        return [];
      }
      return [`### ${labels[index + 1]}`, cell.markdown];
    });
    return [`## ${title}`, ...sections].join('\n\n');
  }).join('\n\n');
}

function plainText(markdown: string): string {
  return markdown
    .replace(/\*\*|~~|`|\*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBlockType(block: LarkBlock): boolean {
  return ['bullet', 'ordered', 'todo', 'quote', 'code', 'divider', 'callout', 'table', 'image', 'file'].includes(block.kind);
}

function isListType(block: LarkBlock): boolean {
  return ['bullet', 'ordered', 'todo'].includes(block.kind);
}

function escapeTableCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function imageToken(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const token = value.token ?? value.image_token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
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

function mcpErrorMessage(response: unknown): string | undefined {
  if (!isRecord(response) || response.isError !== true || !Array.isArray(response.content)) {
    return undefined;
  }
  const text = response.content.find((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string')?.text;
  if (text === undefined) {
    return 'MCP 调用失败';
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && typeof parsed.errorMessage === 'string' ? parsed.errorMessage : 'MCP 调用失败';
  } catch {
    return 'MCP 调用失败';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
