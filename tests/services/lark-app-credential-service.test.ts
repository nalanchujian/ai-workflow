import { describe, expect, it } from 'vitest';

import { LarkAppCredentialService } from '../../src/services/lark-app-credential-service.js';

describe('LarkAppCredentialService', () => {
  it('persists only the app secret through the supplied secret store', async () => {
    const values = new Map<string, string>();
    const service = new LarkAppCredentialService({
      secrets: {
        async read(key) { return values.get(key); },
        async write(key, value) { values.set(key, value); },
        async remove(key) { values.delete(key); },
      },
    });

    await service.saveAppSecret(' app-secret ');

    await expect(service.appSecret()).resolves.toBe('app-secret');
    expect([...values.keys()]).toEqual(['lark-app-credential/v1']);
  });

  it('asks for configuration when no app secret exists', async () => {
    const service = new LarkAppCredentialService({
      secrets: { async read() { return undefined; }, async write() {}, async remove() {} },
    });

    await expect(service.appSecret()).rejects.toMatchObject({ code: 'LARK_AUTH_EXPIRED' });
  });
});
