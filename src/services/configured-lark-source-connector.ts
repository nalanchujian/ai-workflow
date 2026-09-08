import type { NetworkClient } from '../ports/network-client.js';
import type { ConnectedDocumentSource, SourceConnector } from '../ports/source-connector.js';
import { LarkOpenApiSourceConnector } from './lark-openapi-source-connector.js';
import { LocalConfig } from './local-config.js';

export class ConfiguredLarkSourceConnector implements SourceConnector {
  constructor(private readonly deps: { config: LocalConfig; network: NetworkClient }) {}

  supports(input: string): boolean {
    return new LarkOpenApiSourceConnector({
      network: this.deps.network,
      config: { appId: 'unconfigured', appSecret: 'unconfigured', domain: 'https://open.larksuite.com' },
    }).supports(input);
  }

  async fetch(input: string, options?: { section?: string }): Promise<ConnectedDocumentSource> {
    const config = await this.deps.config.larkConnector();
    return new LarkOpenApiSourceConnector({
      network: this.deps.network,
      config,
    }).fetch(input, options);
  }
}
