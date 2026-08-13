import { readFile } from 'node:fs/promises';

import type { McpServerConfigResolver, McpServerDescriptor } from '../ports/mcp-server-config-resolver.js';
import type { McpServerCatalog } from '../ports/mcp-server-catalog.js';

export class CodexTomlMcpServerConfigResolver implements McpServerConfigResolver, McpServerCatalog {
  async resolve(input: { source: 'codex-toml'; path: string; server: string }): Promise<McpServerDescriptor> {
    try {
      const content = await readFile(input.path, 'utf8');
      const section = sectionForServer(content, input.server);
      const command = stringValue(section, 'command');
      const args = arrayValue(section, 'args');
      if (command === undefined || args === undefined) {
        throw new Error('MCP Server 定义不完整');
      }
      return { transport: 'stdio', command, args, env: environmentValue(section) };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '无法解析 MCP 配置');
    }
  }

  async list(input: { source: 'codex-toml'; path: string }): Promise<Array<{ name: string; descriptor: McpServerDescriptor }>> {
    try {
      const content = await readFile(input.path, 'utf8');
      return await Promise.all(serverNames(content).map(async (name) => ({
        name,
        descriptor: await this.resolve({ source: input.source, path: input.path, server: name }),
      })));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '无法解析 MCP 配置');
    }
  }
}

function serverNames(content: string): string[] {
  return content.split(/\r?\n/)
    .map((line) => /^\[mcp_servers\.([^\].]+)\]\s*$/.exec(line.trim())?.[1])
    .filter((name): name is string => name !== undefined);
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
  if (match === null) {
    return undefined;
  }
  return Array.from(match[1].matchAll(/"([^"\\]*)"/g), (value) => value[1]);
}

function environmentValue(section: string): Record<string, string> {
  const match = /^env\s*=\s*\{([^}]*)\}\s*$/m.exec(section);
  if (match === null) {
    if (/^env\s*=/m.test(section)) {
      throw new Error('MCP Server 环境变量格式无效');
    }
    return {};
  }
  if (match[1].trim() === '') {
    return {};
  }
  return Object.fromEntries(match[1].split(',').map((entry) => {
    const value = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"\\]*)"\s*$/.exec(entry);
    if (value === null) {
      throw new Error('MCP Server 环境变量格式无效');
    }
    return [value[1], value[2]];
  }));
}
