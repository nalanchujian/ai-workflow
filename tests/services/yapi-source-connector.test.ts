import { describe, expect, it } from 'vitest';

import { YapiSourceConnector, YapiSourceConnectorError, parseYapiDocumentIds, yapiInterfaceDocumentUrl } from '../../src/services/yapi-source-connector.js';
import type { NetworkClient, NetworkResponse } from '../../src/ports/network-client.js';

describe('YapiSourceConnector', () => {
  it('accepts only the configured YApi interface document URL and renders its API contract', async () => {
    const requests: string[] = [];
    const connector = new YapiSourceConnector({
      network: network((input) => {
        requests.push(input.url);
        return response(JSON.stringify({
          errcode: 0,
          data: {
            title: '获取追踪链接', method: 'get', path: '/tracking-link/detail', desc: '按 ID 查询链接详情。',
            req_headers: [{ name: 'authorization', required: '1', value: 'Bearer token', desc: '登录令牌' }],
            req_query: [{ name: 'id', required: '1', example: '17904', desc: '链接 ID' }],
            req_body_other: '{"ignored":true}',
            res_body_type: 'json', res_body: '{"status":0,"data":{}}',
          },
        }));
      }),
    });

    expect(connector.supports('https://yapi.hbdev.club/project/149/interface/api/17904')).toBe(true);
    expect(connector.supports('https://yapi.hbdev.club/project/150/interface/api/17904')).toBe(false);
    const document = await connector.fetch('https://yapi.hbdev.club/project/149/interface/api/17904');

    expect(requests).toEqual(['https://yapi.hbdev.club/api/interface/get?id=17904']);
    expect(document).toMatchObject({
      canonicalUrl: 'https://yapi.hbdev.club/project/149/interface/api/17904',
      externalId: '17904',
      title: '获取追踪链接',
      extractor: 'yapi-interface-api/v1',
    });
    expect(document.markdown).toContain('`GET /tracking-link/detail`');
    expect(document.markdown).toContain('| authorization | 是 | Bearer token | 登录令牌 |');
    expect(document.markdown).toContain('## 响应示例');
  });

  it('normalizes batch IDs, removes duplicates, and rejects non-ID input', () => {
    expect(parseYapiDocumentIds(['17879, 17884', '17904，17879'])).toEqual(['17879', '17884', '17904']);
    expect(yapiInterfaceDocumentUrl('17904')).toBe('https://yapi.hbdev.club/project/149/interface/api/17904');
    expect(() => parseYapiDocumentIds(['17904', 'api/17909'])).toThrow(YapiSourceConnectorError);
  });

  it('reports YApi failures with a user-actionable error', async () => {
    const connector = new YapiSourceConnector({ network: network(() => response(JSON.stringify({ errcode: 400, errmsg: 'interface not found' }))) });
    await expect(connector.fetch('https://yapi.hbdev.club/project/149/interface/api/17904'))
      .rejects.toThrow('读取 YApi 接口文档 17904 失败：interface not found');
  });
});

function network(fetcher: (input: { url: string; timeoutMs: number }) => NetworkResponse): NetworkClient {
  return { async fetch(input) { return fetcher(input); }, async resolve() { return ['8.8.8.8']; } };
}

function response(body: string): NetworkResponse {
  return { body, contentType: 'application/json', status: 200, url: 'https://yapi.hbdev.club/api/interface/get' };
}
