import type { NetworkClient, NetworkResponse } from '../../src/ports/network-client.js';

export class FakeNetworkClient implements NetworkClient {
  async fetch(input: { url: string; timeoutMs: number; vettedAddresses?: string[] }): Promise<NetworkResponse> {
    return { body: '', contentType: 'text/plain', url: input.url };
  }

  async resolve(): Promise<string[]> {
    return ['8.8.8.8'];
  }
}
