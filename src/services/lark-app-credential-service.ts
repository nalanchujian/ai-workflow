import type { SecretStore } from '../ports/secret-store.js';
import { LarkSourceConnectorError } from './lark-source-connector.js';

const SECRET_KEY = 'lark-app-credential/v1';

/** Stores only the app secret. User access tokens are intentionally never persisted. */
export class LarkAppCredentialService {
  constructor(private readonly deps: { secrets: SecretStore }) {}

  async saveAppSecret(appSecret: string): Promise<void> {
    if (appSecret.trim().length === 0) throw new Error('App Secret 不能为空');
    await this.deps.secrets.write(SECRET_KEY, appSecret.trim());
  }

  async appSecret(): Promise<string> {
    const value = await this.deps.secrets.read(SECRET_KEY);
    if (value === undefined || value.length === 0) {
      throw new LarkSourceConnectorError('LARK_AUTH_EXPIRED', '未配置 Lark App Secret，请运行 aiw lark configure');
    }
    return value;
  }
}
