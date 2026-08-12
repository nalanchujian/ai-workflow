import { readFile } from 'node:fs/promises';

import type { McpServerConfigResolver, McpServerDescriptor } from '../ports/mcp-server-config-resolver.js';

export class CodexTomlMcpServerConfigResolver implements McpServerConfigResolver {
  async resolve(input: { source: 'codex-toml'; path: string; server: string }): Promise<McpServerDescriptor> {
    try {
      const content = await readFile(input.path, 'utf8');
      const section = sectionForServer(content, input.server);
      const command = stringValue(section, 'command');
      const args = arrayValue(section, 'args');
      if (command === undefined || args === undefined) {
        throw new Error('MCP Server 定义不完整');
      }
      return { transport: 'stdio', command, args, env: {} };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '无法解析 MCP 配置');
    }
  }
}

function sectionForServer(content: string, server: string): string {
  const header = `[mcp_servers.${server}]`;
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    throw new Error('未找到已配置的 MCP Server');
  }
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trimStart().startsWith('[')) {
      break;
    }
    body.push(line);
  }
  return body.join('\n');
}

function stringValue(section: string, key: string): string | undefined {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*$`, 'm').exec(section);
  return match?.[1];
}

function arrayValue(section: string, key: string): string[] | undefined {
  const match = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]\\s*$`, 'm').exec(section);
  return match?.[1].split(',').map((value) => value.trim().replace(/^"|"$/g, '')).filter(Boolean);
}
