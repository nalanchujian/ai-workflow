import { lookup } from 'node:dns/promises';

import type { NetworkClient, NetworkResponse } from '../ports/network-client.js';

export class FetchNetworkClient implements NetworkClient {
  async fetch(input: { url: string; timeoutMs: number }): Promise<NetworkResponse> {
    const response = await fetch(input.url, { redirect: 'manual', signal: AbortSignal.timeout(input.timeoutMs) });
    return {
      body: await response.text(),
      contentType: response.headers.get('content-type') ?? '',
      ...(response.headers.get('location') === null ? {} : { location: response.headers.get('location') ?? undefined }),
      status: response.status,
      url: response.url,
    };
  }

  async resolve(hostname: string): Promise<string[]> {
    return (await lookup(hostname, { all: true })).map((entry) => entry.address);
  }
}
