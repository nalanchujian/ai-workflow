import { createServer, get } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LarkAppCredentialService } from '../../src/services/lark-app-credential-service.js';
import { LocalConfig } from '../../src/services/local-config.js';
import { LarkUserOAuthService } from '../../src/services/lark-user-oauth-service.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('LarkUserOAuthService', () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(directories.splice(0).map(removeTempDirectory));
  });

  it('uses direct OIDC authorization without explicitly requesting document scopes', async () => {
    const directory = await createTempDirectory('aiw-lark-oauth-');
    directories.push(directory);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const port = await availablePort();
    await writeFile(join(directory, 'config.yaml'), config(port));
    const calls: Array<{ url: string; headers?: Record<string, string>; body?: string }> = [];
    const credentials = new LarkAppCredentialService({
      secrets: { async read() { return 'app-secret'; }, async write() {}, async remove() {} },
    });
    const oauth = new LarkUserOAuthService({
      config: new LocalConfig(join(directory, 'config.yaml')),
      credentials,
      browser: {
        async open(url) {
          const authorizationUrl = new URL(url);
          expect(authorizationUrl.pathname).toBe('/open-apis/authen/v1/index');
          expect(authorizationUrl.searchParams.get('app_id')).toBe('cli_xxx');
          expect(authorizationUrl.searchParams.has('scope')).toBe(false);
          const callback = new URL(authorizationUrl.searchParams.get('redirect_uri')!);
          callback.searchParams.set('code', 'authorization-code');
          callback.searchParams.set('state', authorizationUrl.searchParams.get('state')!);
          await new Promise<void>((resolve, reject) => {
            get(callback, (response) => { response.resume(); response.once('end', resolve); }).once('error', reject);
          });
        },
      },
      network: {
        async fetch(input) {
          calls.push(input);
          if (input.url.endsWith('/auth/v3/app_access_token/internal')) {
            return { body: JSON.stringify({ app_access_token: 'app-token' }), contentType: 'application/json', status: 200, url: input.url };
          }
          return { body: JSON.stringify({ code: 0, data: { access_token: 'user-token' } }), contentType: 'application/json', status: 200, url: input.url };
        },
        async resolve() { return []; },
      },
    });

    await expect(oauth.authorize()).resolves.toBe('user-token');
    expect(calls).toEqual([
      expect.objectContaining({ url: 'https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal', body: JSON.stringify({ app_id: 'cli_xxx', app_secret: 'app-secret' }) }),
      expect.objectContaining({ url: 'https://open.larksuite.com/open-apis/authen/v1/oidc/access_token', headers: expect.objectContaining({ authorization: 'Bearer app-token' }), body: JSON.stringify({ grant_type: 'authorization_code', code: 'authorization-code' }) }),
    ]);
  });
});

function config(port: number): string {
  return ['schemaVersion: aiw.local/v1', 'connectors:', '  lark:', '    appId: cli_xxx', '    domain: https://open.larksuite.com', '    callback:', '      host: 127.0.0.1', `      port: ${port}`, ''].join('\n');
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (port === undefined) throw new Error('无法分配测试端口');
  return port;
}
