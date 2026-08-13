import type { McpClient } from '../ports/mcp-client.js';
import type { McpServerConfigResolver } from '../ports/mcp-server-config-resolver.js';
import { LarkSourceConnector, type ConnectorSource, type SourceConnector } from './lark-source-connector.js';
import { LocalConfig } from './local-config.js';

export class ConfiguredLarkSourceConnector implements SourceConnector {
  constructor(private readonly deps: { config: LocalConfig; client: McpClient; resolver: McpServerConfigResolver }) {}

  supports(input: string): boolean {
    return new LarkSourceConnector({
      client: this.deps.client,
      resolver: this.deps.resolver,
      config: { configPath: '', server: '', tool: '', useUAT: false },
    }).supports(input);
  }

  async fetch(input: string, options?: { section?: string }): Promise<ConnectorSource> {
    const config = await this.deps.config.larkConnector();
    return new LarkSourceConnector({
      client: this.deps.client,
      resolver: this.deps.resolver,
      config: { configPath: config.configSource.path, server: config.server, tool: config.tool, useUAT: config.useUAT },
    }).fetch(input, options);
  }
}
