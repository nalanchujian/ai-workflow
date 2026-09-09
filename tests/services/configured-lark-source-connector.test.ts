import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfiguredLarkSourceConnector } from '../../src/services/configured-lark-source-connector.js';
import { LocalConfig } from '../../src/services/local-config.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('ConfiguredLarkSourceConnector', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('reads a selected section through the configured user-identity MCP', async () => {
    const directory = await createTempDirectory('aiw-lark-mcp-');
    directories.push(directory);
    await writeFile(join(directory, 'config.yaml'), [
      'schemaVersion: aiw.local/v1', 'connectors:', '  lark:', '    mcp:', '      configPath: /local/config.toml', '      server: lark-openapi', '      tool: docx_v1_document_rawContent', '      useUAT: true', '',
    ].join('\n'));
    const connector = new ConfiguredLarkSourceConnector({
      config: new LocalConfig(join(directory, 'config.yaml')),
      resolver: {
        async resolve() { return { args: [], command: 'lark-mcp', env: {}, transport: 'stdio' }; },
      },
      client: {
        async callTool() {
          return { content: [{ type: 'text', text: JSON.stringify({ has_more: false, items: [heading('target', '二期'), text('content', '目标需求'), heading('after', '三期')] }) }] };
        },
      },
    });

    await expect(connector.fetch('https://acme.larksuite.com/docx/doccn123', { section: '二期' }))
      .resolves.toMatchObject({ markdown: '# 二期\n\n目标需求', section: { startBlockId: 'target', endBlockId: 'content' }, extractor: 'lark-mcp/v1' });
  });
});

function heading(id: string, content: string) {
  return { block_id: id, block_type: 3, heading1: { elements: [{ text_run: { content } }] } };
}

function text(id: string, content: string) {
  return { block_id: id, block_type: 2, text: { elements: [{ text_run: { content } }] } };
}
