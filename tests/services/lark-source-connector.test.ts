import { describe, expect, it } from 'vitest';

import type { McpClient } from '../../src/ports/mcp-client.js';
import type { McpServerConfigResolver } from '../../src/ports/mcp-server-config-resolver.js';
import { LarkSourceConnector } from '../../src/services/lark-source-connector.js';

describe('LarkSourceConnector', () => {
  it('retrieves a recognized document through the configured MCP tool and normalizes its result', async () => {
    const resolver: McpServerConfigResolver = {
      async resolve() {
        return { args: [], command: 'lark-mcp', env: {}, transport: 'stdio' };
      },
    };
    const client: McpClient = {
      async callTool() {
        return { data: { content: '# Refund requirements' } };
      },
    };
    const connector = new LarkSourceConnector({
      client,
      config: { configPath: '/local/config.toml', server: 'lark-openapi', tool: 'docx_v1_document_rawContent', useUAT: false },
      resolver,
    });

    const source = await connector.fetch('https://example.larksuite.com/docx/doccn123');

    expect(source).toMatchObject({
      canonicalUrl: 'https://example.larksuite.com/docx/doccn123',
      externalId: 'doccn123',
      extractor: 'lark-mcp/v1',
      markdown: '# Refund requirements',
    });
  });

  it('maps an unavailable MCP server without exposing its error details', async () => {
    const connector = new LarkSourceConnector({
      client: { async callTool() { throw new Error('token=secret'); } },
      config: { configPath: '/local/config.toml', server: 'lark-openapi', tool: 'docx_v1_document_rawContent', useUAT: false },
      resolver: { async resolve() { return { args: [], command: 'lark-mcp', env: {}, transport: 'stdio' }; } },
    });

    await expect(connector.fetch('https://example.larksuite.com/docx/doccn123'))
      .rejects.toMatchObject({ code: 'LARK_MCP_UNAVAILABLE', message: 'Lark MCP 不可用' });
  });

  it('asks the user to reauthorize when the Lark OAuth login has expired', async () => {
    const connector = new LarkSourceConnector({
      client: {
        async callTool() {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ errorMessage: 'Current user_access_token is invalid or expired' }) }],
          };
        },
      },
      config: { configPath: '/local/config.toml', server: 'lark-openapi', tool: 'docx_v1_document_rawContent', useUAT: false },
      resolver: { async resolve() { return { args: [], command: 'lark-mcp', env: {}, transport: 'stdio' }; } },
    });

    await expect(connector.fetch('https://example.larksuite.com/docx/doccn123'))
      .rejects.toMatchObject({ code: 'LARK_AUTH_EXPIRED', message: 'Lark Connector 登录状态已失效，请重新授权后重试' });
  });

  it('recognizes a docx URL under a multi-label Lark tenant domain', () => {
    const connector = new LarkSourceConnector({
      client: { async callTool() { throw new Error('不应调用'); } },
      config: { configPath: '/local/config.toml', server: 'lark-openapi', tool: 'docx_v1_document_rawContent', useUAT: false },
      resolver: { async resolve() { throw new Error('不应调用'); } },
    });

    expect(connector.supports('https://jphmzyvzr43.jp.larksuite.com/docx/doccn123')).toBe(true);
  });

  it('resolves a Wiki node to its docx document before reading Markdown', async () => {
    const calls: Array<{ tool: string; arguments: unknown }> = [];
    const connector = new LarkSourceConnector({
      client: {
        async callTool(input) {
          calls.push({ tool: input.tool, arguments: input.arguments });
          return input.tool === 'wiki_v2_space_getNode'
            ? { content: [{ type: 'text', text: JSON.stringify({ node: { obj_type: 'docx', obj_token: 'doccn123' } }) }] }
            : { content: [{ type: 'text', text: JSON.stringify({ content: '# 需求正文' }) }] };
        },
      },
      config: { configPath: '/local/config.toml', server: 'lark-openapi', tool: 'docx_v1_document_rawContent', useUAT: false },
      resolver: { async resolve() { return { args: [], command: 'lark-mcp', env: {}, transport: 'stdio' }; } },
    });

    await expect(connector.fetch('https://jphmzyvzr43.jp.larksuite.com/wiki/DJJXwQUSui36aEkFz8QjwPRTp8e'))
      .resolves.toMatchObject({
        canonicalUrl: 'https://jphmzyvzr43.jp.larksuite.com/wiki/DJJXwQUSui36aEkFz8QjwPRTp8e',
        externalId: 'DJJXwQUSui36aEkFz8QjwPRTp8e',
        resolvedExternalId: 'doccn123',
        markdown: '# 需求正文',
      });
    expect(calls).toEqual([
      { tool: 'wiki_v2_space_getNode', arguments: { params: { token: 'DJJXwQUSui36aEkFz8QjwPRTp8e' }, useUAT: false } },
      { tool: 'docx_v1_document_rawContent', arguments: { path: { document_id: 'doccn123' }, params: { lang: 0 }, useUAT: false } },
    ]);
  });

  it('rejects a Wiki node that does not resolve to a docx document', async () => {
    const connector = new LarkSourceConnector({
      client: { async callTool() { return { content: [{ type: 'text', text: JSON.stringify({ node: { obj_type: 'sheet', obj_token: 'sheet123' } }) }] }; } },
      config: { configPath: '/local/config.toml', server: 'lark-openapi', tool: 'docx_v1_document_rawContent', useUAT: false },
      resolver: { async resolve() { return { args: [], command: 'lark-mcp', env: {}, transport: 'stdio' }; } },
    });

    await expect(connector.fetch('https://acme.larksuite.com/wiki/DJJXwQUSui36aEkFz8QjwPRTp8e'))
      .rejects.toMatchObject({ code: 'LARK_URL_UNSUPPORTED', message: 'Wiki 节点不是可读取的 docx 文档' });
  });

  it('reads Lark Blocks to select a section from a non-Markdown document', async () => {
    const calls: Array<{ tool: string; arguments: unknown }> = [];
    const connector = new LarkSourceConnector({
      client: {
        async callTool(input) {
          calls.push({ tool: input.tool, arguments: input.arguments });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                has_more: false,
                items: [
                  block('root', 1, '文档标题'),
                  block('before', 3, '一期'),
                  block('before-content', 2, '一期内容'),
                  block('target', 3, '二期 (V2.3)'),
                  block('target-content', 2, '目标需求'),
                  block('child', 4, '子需求'),
                  block('child-content', 2, '子需求内容'),
                  block('after', 3, '三期'),
                  block('after-content', 2, '不应包含'),
                ],
              }),
            }],
          };
        },
      },
      config: { configPath: '/local/config.toml', server: 'lark-openapi', tool: 'docx_v1_document_rawContent', useUAT: false },
      resolver: { async resolve() { return { args: [], command: 'lark-mcp', env: {}, transport: 'stdio' }; } },
    });

    await expect(connector.fetch('https://acme.larksuite.com/docx/doccn123', { section: '二期 (V2.3)' }))
      .resolves.toMatchObject({
        markdown: '# 二期 (V2.3)\n\n目标需求\n\n## 子需求\n\n子需求内容',
        section: { title: '二期 (V2.3)', startBlockId: 'target', endBlockId: 'child-content' },
      });
    expect(calls).toEqual([
      {
        tool: 'docx_v1_documentBlock_list',
        arguments: { path: { document_id: 'doccn123' }, params: { document_revision_id: -1, page_size: 500 }, useUAT: false },
      },
    ]);
  });

  it('preserves Lark list, quote, code, rich text and table structure in a selected section', async () => {
    const connector = new LarkSourceConnector({
      client: {
        async callTool() {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                has_more: false,
                items: [
                  block('target', 3, '二期 (V2.3)'),
                  richBlock('paragraph', 'text', '支持', { bold: true, link: { url: 'https%3A%2F%2Fexample.com%2Fspec' } }),
                  richBlock('bullet', 'bullet', '可调整展示顺序'),
                  richBlock('ordered', 'ordered', '导出结果保持一致'),
                  richBlock('quote', 'quote', '依赖接口确认'),
                  { block_id: 'code', block_type: 14, code: { elements: [{ text_run: { content: 'const enabled = true;' } }], style: { language: 49 } } },
                  { block_id: 'table', block_type: 31, table: { cells: ['header-a', 'header-b', 'value-a', 'value-b'], property: { row_size: 2, column_size: 2 } } },
                  tableCell('header-a', 'header-a-text'),
                  richBlock('header-a-text', 'text', '字段', {}, 'header-a'),
                  tableCell('header-b', 'header-b-text'),
                  richBlock('header-b-text', 'text', '说明', {}, 'header-b'),
                  tableCell('value-a', 'value-a-text'),
                  richBlock('value-a-text', 'text', 'Clicks', {}, 'value-a'),
                  tableCell('value-b', 'value-b-text'),
                  richBlock('value-b-text', 'text', '点击数', {}, 'value-b'),
                  block('after', 3, '三期'),
                ],
              }),
            }],
          };
        },
      },
      config: { configPath: '/local/config.toml', server: 'lark-openapi', tool: 'docx_v1_document_rawContent', useUAT: false },
      resolver: { async resolve() { return { args: [], command: 'lark-mcp', env: {}, transport: 'stdio' }; } },
    });

    await expect(connector.fetch('https://acme.larksuite.com/docx/doccn123', { section: '二期 (V2.3)' }))
      .resolves.toMatchObject({
        markdown: [
          '# 二期 (V2.3)',
          '',
          '[**支持**](https://example.com/spec)',
          '',
          '- 可调整展示顺序',
          '',
          '1. 导出结果保持一致',
          '',
          '> 依赖接口确认',
          '',
          '```',
          'const enabled = true;',
          '```',
          '',
          '| 字段 | 说明 |',
          '| --- | --- |',
          '| Clicks | 点击数 |',
        ].join('\n'),
      });
  });

  it('keeps image and rich-text references instead of silently dropping document blocks', async () => {
    const connector = new LarkSourceConnector({
      client: { async callTool() { return { content: [{ type: 'text', text: JSON.stringify({ has_more: false, items: [
        block('target', 3, '二期 (V2.3)'),
        { block_id: 'image', block_type: 27, image: { token: 'imgcn123' } },
        { block_id: 'reference', block_type: 2, text: { elements: [{ mention_doc: { title: '交互说明', token: 'doccn456' } }] } },
        block('after', 3, '三期'),
      ] }) }] }; } },
      config: { configPath: '/local/config.toml', server: 'lark-openapi', tool: 'docx_v1_document_rawContent', useUAT: false },
      resolver: { async resolve() { return { args: [], command: 'lark-mcp', env: {}, transport: 'stdio' }; } },
    });

    await expect(connector.fetch('https://acme.larksuite.com/docx/doccn123', { section: '二期 (V2.3)' }))
      .resolves.toMatchObject({ markdown: '# 二期 (V2.3)\n\n![Lark 图片（imgcn123）](lark-image://imgcn123)\n\n[交互说明](lark-doc://doccn456)' });
  });

  it('expands a table row into recursive Markdown when a cell contains nested blocks', async () => {
    const connector = new LarkSourceConnector({
      client: {
        async callTool() {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                has_more: false,
                items: [
                  block('target', 3, '二期 (V2.3)'),
                  { block_id: 'table', block_type: 31, table: { cells: ['header-a', 'header-b', 'value-a', 'value-b'], property: { row_size: 2, column_size: 2 } } },
                  tableCell('header-a', 'header-a-text'),
                  richBlock('header-a-text', 'text', 'Feature name', {}, 'header-a'),
                  tableCell('header-b', 'header-b-text'),
                  richBlock('header-b-text', 'text', 'Feature Details', {}, 'header-b'),
                  tableCell('value-a', 'value-a-text'),
                  richBlock('value-a-text', 'text', '主表格', {}, 'value-a'),
                  { block_id: 'value-b', block_type: 32, table_cell: {}, children: ['intro', 'export', 'quote'] },
                  richBlock('intro', 'text', 'Free Trial+Tracking links:', {}, 'value-b'),
                  richBlock('export', 'bullet', '导出更新', {}, 'value-b', ['all-data']),
                  richBlock('all-data', 'bullet', 'All data', { bold: true }, 'export'),
                  richBlock('quote', 'quote', '仅支持已选择的字段', { strikethrough: true }, 'value-b'),
                  block('after', 3, '三期'),
                ],
              }),
            }],
          };
        },
      },
      config: { configPath: '/local/config.toml', server: 'lark-openapi', tool: 'docx_v1_document_rawContent', useUAT: false },
      resolver: { async resolve() { return { args: [], command: 'lark-mcp', env: {}, transport: 'stdio' }; } },
    });

    await expect(connector.fetch('https://acme.larksuite.com/docx/doccn123', { section: '二期 (V2.3)' }))
      .resolves.toMatchObject({
        markdown: [
          '# 二期 (V2.3)',
          '',
          '## 主表格',
          '',
          '### Feature Details',
          '',
          'Free Trial+Tracking links:',
          '',
          '- 导出更新',
          '  - **All data**',
          '',
          '> ~~仅支持已选择的字段~~',
        ].join('\n'),
      });
  });
});

function block(id: string, blockType: number, content: string): Record<string, unknown> {
  if (blockType === 1) {
    return { block_id: id, block_type: blockType, page: { elements: [{ text_run: { content } }] } };
  }
  const key = blockType === 2 ? 'text' : `heading${blockType - 2}`;
  return { block_id: id, block_type: blockType, [key]: { elements: [{ text_run: { content } }] } };
}

function richBlock(
  id: string,
  type: string,
  content: string,
  style: Record<string, unknown> = {},
  parentId?: string,
  children?: string[],
): Record<string, unknown> {
  return {
    block_id: id,
    block_type: type === 'text' ? 2 : type === 'bullet' ? 12 : type === 'ordered' ? 13 : 15,
    ...(parentId === undefined ? {} : { parent_id: parentId }),
    ...(children === undefined ? {} : { children }),
    [type]: { elements: [{ text_run: { content, text_element_style: style } }] },
  };
}

function tableCell(id: string, childId: string): Record<string, unknown> {
  return { block_id: id, block_type: 32, table_cell: {}, children: [childId] };
}
