export interface McpServerDescriptor {
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  startupTimeoutMs?: number;
}

export interface McpServerConfigResolver {
  resolve(input: { source: 'codex-toml'; path: string; server: string }): Promise<McpServerDescriptor>;
}
