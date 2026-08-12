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
});
