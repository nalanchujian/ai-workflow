import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import type { BrowserOpener } from '../ports/browser-opener.js';
import type { NetworkClient } from '../ports/network-client.js';
import { LarkAppCredentialService } from './lark-app-credential-service.js';
import { LocalConfig, type LocalLarkConnectorProfile } from './local-config.js';
import { LarkSourceConnectorError } from './lark-source-connector.js';

const LOGIN_TIMEOUT_MS = 120_000;

/** Starts a fresh OAuth authorization for each Lark document read. No user token is stored. */
export class LarkUserOAuthService {
  constructor(private readonly deps: { browser: BrowserOpener; config: LocalConfig; credentials: LarkAppCredentialService; network: NetworkClient }) {}

  async authorize(): Promise<string> {
    const profile = await this.profile();
    const appSecret = await this.deps.credentials.appSecret();
    const callbackUrl = `http://${profile.callback.host}:${profile.callback.port}/callback`;
    const state = randomBytes(24).toString('base64url');
    const callback = await this.startCallbackServer(profile.callback, state);
    try {
      const authorizeUrl = new URL('/open-apis/authen/v1/index', profile.domain);
      authorizeUrl.searchParams.set('app_id', profile.appId);
      authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
      authorizeUrl.searchParams.set('state', state);
      process.stderr.write(`请在浏览器完成本次 Lark 授权；若未自动打开，请访问：${authorizeUrl}\n`);
      await this.deps.browser.open(authorizeUrl.toString());
      const code = await callback.code;
      return this.exchange(profile, { code, appSecret });
    } finally {
      await close(callback.server);
    }
  }

  private async exchange(profile: LocalLarkConnectorProfile, input: { code: string; appSecret: string }): Promise<string> {
    try {
      const baseUrl = profile.domain.replace(/\/$/, '');
      const appTokenResponse = await this.deps.network.fetch({
        url: `${baseUrl}/open-apis/auth/v3/app_access_token/internal`,
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: profile.appId, app_secret: input.appSecret }),
        timeoutMs: 30_000,
      });
      const appTokenBody: unknown = JSON.parse(appTokenResponse.body);
      if (appTokenResponse.status !== 200 || !isRecord(appTokenBody) || typeof appTokenBody.app_access_token !== 'string' || appTokenBody.app_access_token.length === 0) throw new Error('invalid');
      const userTokenResponse = await this.deps.network.fetch({
        url: `${baseUrl}/open-apis/authen/v1/oidc/access_token`,
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${appTokenBody.app_access_token}` },
        body: JSON.stringify({ grant_type: 'authorization_code', code: input.code }),
        timeoutMs: 30_000,
      });
      const userTokenBody: unknown = JSON.parse(userTokenResponse.body);
      const data = isRecord(userTokenBody) ? userTokenBody.data : undefined;
      if (userTokenResponse.status !== 200 || !isRecord(userTokenBody) || userTokenBody.code !== 0 || !isRecord(data) || typeof data.access_token !== 'string' || data.access_token.length === 0) throw new Error('invalid');
      return data.access_token;
    } catch {
      throw new LarkSourceConnectorError('LARK_AUTH_EXPIRED', 'Lark 用户授权失败，请重新运行当前命令');
    }
  }

  private async profile(): Promise<LocalLarkConnectorProfile> {
    try {
      return await this.deps.config.larkConnector();
    } catch {
      throw new LarkSourceConnectorError('LARK_AUTH_EXPIRED', '未配置 Lark 用户身份，请运行 aiw lark configure');
    }
  }

  private async startCallbackServer(callback: LocalLarkConnectorProfile['callback'], expectedState: string): Promise<{ server: Server; code: Promise<string> }> {
    let resolveCode: ((code: string) => void) | undefined;
    let rejectCode: ((error: Error) => void) | undefined;
    const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${callback.host}:${callback.port}`);
      const authorizationCode = url.searchParams.get('code');
      if (url.pathname !== '/callback' || authorizationCode === null || url.searchParams.get('state') !== expectedState) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Lark 授权校验失败，请回到终端重试。');
        rejectCode?.(new LarkSourceConnectorError('LARK_AUTH_EXPIRED', 'Lark 授权回调校验失败，请重新运行当前命令'));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Lark 授权成功，可以关闭此页面并返回终端。');
      resolveCode?.(authorizationCode);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(callback.port, callback.host, () => { server.removeListener('error', reject); resolve(); });
    });
    const timeout = setTimeout(() => rejectCode?.(new LarkSourceConnectorError('LARK_AUTH_EXPIRED', '等待 Lark 授权超时，请重新运行当前命令')), LOGIN_TIMEOUT_MS);
    void code.then(() => clearTimeout(timeout), () => clearTimeout(timeout));
    return { server, code };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
