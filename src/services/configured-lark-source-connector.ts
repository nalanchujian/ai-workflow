import type { ConnectedDocumentSource, SourceConnector } from '../ports/source-connector.js';
import type { McpClient } from '../ports/mcp-client.js';
import type { McpServerConfigResolver } from '../ports/mcp-server-config-resolver.js';
import { LarkSourceConnector } from './lark-source-connector.js';
import { LocalConfig } from './local-config.js';

export class ConfiguredLarkSourceConnector implements SourceConnector {
  constructor(private readonly deps: { config: LocalConfig; client: McpClient; resolver: McpServerConfigResolver }) {}

  supports(input: string): boolean {
    return new LarkSourceConnector({
      client: this.deps.client,
      resolver: this.deps.resolver,
      config: { configPath: 'unconfigured', server: 'unconfigured', tool: 'unconfigured', useUAT: true },
    }).supports(input);
  }

  async fetch(input: string, options?: { section?: string }): Promise<ConnectedDocumentSource> {
    const config = await this.deps.config.larkConnector();
    return new LarkSourceConnector({ client: this.deps.client, resolver: this.deps.resolver, config }).fetch(input, options);
  }
}
