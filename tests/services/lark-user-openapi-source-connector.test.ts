import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalConfig } from '../../src/services/local-config.js';
import { LarkUserOpenApiSourceConnector } from '../../src/services/lark-user-openapi-source-connector.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('LarkUserOpenApiSourceConnector', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('uses one in-memory user token to resolve Wiki and read a selected Docx section', async () => {
    const directory = await createTempDirectory('aiw-lark-user-');
    directories.push(directory);
    await writeFile(join(directory, 'config.yaml'), config());
    const calls: Array<{ url: string; authorization?: string }> = [];
    const connector = new LarkUserOpenApiSourceConnector({
      config: new LocalConfig(join(directory, 'config.yaml')),
      oauth: { async authorize() { return 'user-token'; } } as never,
      network: {
        async fetch(input) {
          calls.push({ url: input.url, authorization: input.headers?.authorization });
          const body = input.url.includes('/wiki/')
            ? { code: 0, data: { node: { obj_type: 'docx', obj_token: 'doccn123' } } }
            : { code: 0, data: { has_more: false, items: [heading('target', '二期'), text('content', '目标需求'), heading('after', '三期')] } };
          return { body: JSON.stringify(body), contentType: 'application/json', status: 200, url: input.url };
        },
        async resolve() { return []; },
      },
    });

    await expect(connector.fetch('https://acme.larksuite.com/wiki/wiki123', { section: '二期' }))
      .resolves.toMatchObject({ markdown: '# 二期\n\n目标需求', extractor: 'lark-user-openapi/v1', resolvedExternalId: 'doccn123' });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.authorization === 'Bearer user-token')).toBe(true);
  });

  it('reports a user permission denial without falling back to app identity', async () => {
    const directory = await createTempDirectory('aiw-lark-user-');
    directories.push(directory);
    await writeFile(join(directory, 'config.yaml'), config());
    const connector = new LarkUserOpenApiSourceConnector({
      config: new LocalConfig(join(directory, 'config.yaml')),
      oauth: { async authorize() { return 'user-token'; } } as never,
      network: {
        async fetch(input) { return { body: JSON.stringify({ code: 99991672, data: {} }), contentType: 'application/json', status: 200, url: input.url }; },
        async resolve() { return []; },
      },
    });

    await expect(connector.fetch('https://acme.larksuite.com/docx/doccn123'))
      .rejects.toMatchObject({ code: 'LARK_AUTHORIZATION_DENIED', message: '当前用户未获授权读取该 Lark 文档' });
  });
});

function config(): string {
  return ['schemaVersion: aiw.local/v1', 'connectors:', '  lark:', '    appId: cli_xxx', '    domain: https://open.larksuite.com', '    callback:', '      host: 127.0.0.1', '      port: 38991', ''].join('\n');
}

function heading(id: string, content: string) {
  return { block_id: id, block_type: 3, heading1: { elements: [{ text_run: { content } }] } };
}

function text(id: string, content: string) {
  return { block_id: id, block_type: 2, text: { elements: [{ text_run: { content } }] } };
}
