import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfiguredLarkSourceConnector } from '../../src/services/configured-lark-source-connector.js';
import { LocalConfig } from '../../src/services/local-config.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('ConfiguredLarkSourceConnector', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('reads a selected section through Lark OpenAPI', async () => {
    const directory = await createTempDirectory('aiw-lark-openapi-');
    directories.push(directory);
    await writeFile(join(directory, 'config.yaml'), [
      'schemaVersion: aiw.local/v1', 'connectors:', '  lark:', '    appId: cli_test', '    appSecret: secret', '    domain: https://open.larksuite.com', '',
    ].join('\n'));
    const connector = new ConfiguredLarkSourceConnector({
      config: new LocalConfig(join(directory, 'config.yaml')),
      network: {
        async fetch(input) {
          if (input.method === 'POST') return { body: JSON.stringify({ code: 0, tenant_access_token: 'tenant-token' }), contentType: 'application/json', status: 200, url: input.url };
          return { body: JSON.stringify({ code: 0, data: { has_more: false, items: [heading('target', '二期'), text('content', '目标需求'), heading('after', '三期')] } }), contentType: 'application/json', status: 200, url: input.url };
        },
        async resolve() { return ['8.8.8.8']; },
      },
    });

    await expect(connector.fetch('https://acme.larksuite.com/docx/doccn123', { section: '二期' }))
      .resolves.toMatchObject({ markdown: '# 二期\n\n目标需求', section: { startBlockId: 'target', endBlockId: 'content' }, extractor: 'lark-openapi/v1' });
  });
});

function heading(id: string, content: string) {
  return { block_id: id, block_type: 3, heading1: { elements: [{ text_run: { content } }] } };
}

function text(id: string, content: string) {
  return { block_id: id, block_type: 2, text: { elements: [{ text_run: { content } }] } };
}
