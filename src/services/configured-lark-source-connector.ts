import type { ConnectedDocumentSource, SourceConnector } from '../ports/source-connector.js';
import type { NetworkClient } from '../ports/network-client.js';
import { LocalConfig } from './local-config.js';
import { LarkUserOAuthService } from './lark-user-oauth-service.js';
import { LarkUserOpenApiSourceConnector } from './lark-user-openapi-source-connector.js';

export class ConfiguredLarkSourceConnector implements SourceConnector {
  constructor(private readonly deps: { config: LocalConfig; network: NetworkClient; oauth: LarkUserOAuthService }) {}

  supports(input: string): boolean {
    return new LarkUserOpenApiSourceConnector(this.deps).supports(input);
  }

  async fetch(input: string, options?: { section?: string }): Promise<ConnectedDocumentSource> {
    return new LarkUserOpenApiSourceConnector(this.deps).fetch(input, options);
  }
}
