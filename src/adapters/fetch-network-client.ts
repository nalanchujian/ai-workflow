import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import type { NetworkClient, NetworkResponse } from '../ports/network-client.js';

export class FetchNetworkClient implements NetworkClient {
  async fetch(input: {
    url: string;
    timeoutMs: number;
    vettedAddresses?: string[];
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
  }): Promise<NetworkResponse> {
    const url = new URL(input.url);
    const vettedAddress = input.vettedAddresses?.[0];
    if (input.vettedAddresses !== undefined && vettedAddress === undefined) {
      throw new Error('缺少已校验的 URL 地址');
    }
    return new Promise<NetworkResponse>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: input.method ?? 'GET',
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        ...(vettedAddress === undefined ? {} : {
          lookup(_hostname, options, callback) {
            const resolved = { address: vettedAddress, family: isIP(vettedAddress) };
            if (options.all) {
              callback(null, [resolved]);
              return;
            }
            callback(null, resolved.address, resolved.family);
          },
        }),
      }, (response) => {
        const contentType = response.headers['content-type'] ?? '';
        const location = response.headers.location;
        const status = response.statusCode;
        if (location !== undefined && status !== undefined && status >= 300 && status < 400) {
          response.resume();
          resolve({ body: '', contentType, location, status, url: url.toString() });
          return;
        }
        const declaredLength = Number(response.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
          response.destroy();
          reject(new Error('URL 响应超过大小上限'));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('URL 响应超过大小上限'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          contentType,
          ...(location === undefined ? {} : { location }),
          status,
          url: url.toString(),
        }));
      });
      request.setTimeout(input.timeoutMs, () => request.destroy(new Error('URL 请求超时')));
      request.once('error', reject);
      request.end(input.body);
    });
  }

  async resolve(hostname: string): Promise<string[]> {
    return (await lookup(hostname, { all: true })).map((entry) => entry.address);
  }
}

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
