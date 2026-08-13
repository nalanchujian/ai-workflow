import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

import { FetchNetworkClient } from '../../src/adapters/fetch-network-client.js';

describe('FetchNetworkClient', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => {
      server.close();
      await once(server, 'close');
    }));
  });

  it('rejects an oversized streamed response before materializing it as text', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(Buffer.alloc(5 * 1024 * 1024 + 1, 'a'));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('无法读取测试端口');
    }

    await expect(new FetchNetworkClient().fetch({
      url: `http://public.test:${address.port}/requirements`,
      timeoutMs: 5_000,
      vettedAddresses: ['127.0.0.1'],
    })).rejects.toThrow('URL 响应超过大小上限');
  });
});
