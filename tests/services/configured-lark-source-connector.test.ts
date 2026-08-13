import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

import { ConfiguredLarkSourceConnector } from '../../src/services/configured-lark-source-connector.js';
import { LocalConfig } from '../../src/services/local-config.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('ConfiguredLarkSourceConnector', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(removeTempDirectory));
  });

  it('forwards the selected section to the configured Lark connector', async () => {
    const directory = await createTempDirectory('aiw-configured-lark-');
    directories.push(directory);
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, `schemaVersion: aiw.local/v1
connectors:
  lark:
    configSource:
      kind: codex-toml
      path: /local/config.toml
    server: lark-openapi
    tool: docx_v1_document_rawContent
    useUAT: false
`);
    const connector = new ConfiguredLarkSourceConnector({
      config: new LocalConfig(configPath),
      client: {
        async callTool() {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                has_more: false,
                items: [
                  { block_id: 'target', heading1: { elements: [{ text_run: { content: '二期 (V2.3)' } }] } },
                  { block_id: 'content', text: { elements: [{ text_run: { content: '目标需求' } }] } },
                ],
              }),
            }],
          };
        },
      },
      resolver: { async resolve() { return { args: [], command: 'lark-mcp', env: {}, transport: 'stdio' }; } },
    });

    await expect(connector.fetch('https://acme.larksuite.com/docx/doccn123', { section: '二期 (V2.3)' }))
      .resolves.toMatchObject({ section: { startBlockId: 'target', endBlockId: 'content' } });
  });
});
