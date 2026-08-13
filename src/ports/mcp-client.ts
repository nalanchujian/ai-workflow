import type { McpServerDescriptor } from './mcp-server-config-resolver.js';

export interface McpClient {
  callTool(input: { server: McpServerDescriptor; tool: string; arguments: unknown }): Promise<unknown>;
  listTools?(input: { server: McpServerDescriptor }): Promise<Array<{ name: string }>>;
}
