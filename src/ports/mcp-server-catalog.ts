import type { McpServerDescriptor } from './mcp-server-config-resolver.js';

/** Lists usable MCP servers from a client-owned configuration file without exposing credentials. */
export interface McpServerCatalog {
  list(input: { source: 'codex-toml'; path: string }): Promise<Array<{ name: string; descriptor: McpServerDescriptor }>>;
}
