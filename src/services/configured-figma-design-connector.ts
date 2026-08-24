import type { McpClient } from '../ports/mcp-client.js';
import type { McpServerConfigResolver } from '../ports/mcp-server-config-resolver.js';
import type { DesignConnector } from '../ports/design-connector.js';
import { FigmaDesignConnector } from './figma-design-connector.js';
import { LocalConfig } from './local-config.js';

export class ConfiguredFigmaDesignConnector implements DesignConnector {
  constructor(private readonly deps: { config: LocalConfig; client: McpClient; resolver: McpServerConfigResolver }) {}

  supports(url: string): boolean {
    return new FigmaDesignConnector({
      client: this.deps.client,
      resolver: this.deps.resolver,
      config: {
        configPath: '', server: '',
        tools: { metadata: '', screenshot: '', designContext: '' },
      },
    }).supports(url);
  }

  async captureRoot(input: { url: string }) {
    return (await this.connector()).captureRoot(input);
  }

  async captureNode(input: { url: string; nodeId: string }) {
    return (await this.connector()).captureNode(input);
  }

  private async connector(): Promise<FigmaDesignConnector> {
    const config = await this.deps.config.figmaConnector();
    return new FigmaDesignConnector({
      client: this.deps.client,
      resolver: this.deps.resolver,
      config: {
        configPath: config.configSource.path,
        server: config.server,
        tools: config.tools,
      },
    });
  }
}
