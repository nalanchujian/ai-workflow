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
});
