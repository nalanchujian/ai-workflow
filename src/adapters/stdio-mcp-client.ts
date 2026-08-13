import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { McpClient } from '../ports/mcp-client.js';
import type { McpServerDescriptor } from '../ports/mcp-server-config-resolver.js';

export class StdioMcpClient implements McpClient {
  async callTool(input: { server: McpServerDescriptor; tool: string; arguments: unknown }): Promise<unknown> {
    return this.request(input.server, 'tools/call', { name: input.tool, arguments: input.arguments });
  }

  async listTools(input: { server: McpServerDescriptor }): Promise<Array<{ name: string }>> {
    const result = await this.request(input.server, 'tools/list', {});
    if (typeof result !== 'object' || result === null || !('tools' in result) || !Array.isArray(result.tools)
      || result.tools.some((tool) => typeof tool !== 'object' || tool === null || typeof tool.name !== 'string')) {
      throw new Error('MCP 返回了无效工具清单');
    }
    return result.tools.map((tool) => ({ name: tool.name }));
  }

  private async request(server: McpServerDescriptor, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(server.command, server.args, {
        env: { ...process.env, ...server.env },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('MCP 调用超时'));
      }, server.startupTimeoutMs ?? 15_000);
      let nextId = 1;
      const pending = new Map<number, (result: unknown) => void>();
      const fail = (error: Error): void => {
        clearTimeout(timeout);
        child.kill();
        reject(error);
      };
      const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolveRequest) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, resolveRequest);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
      child.once('error', (error) => fail(new Error(`MCP 无法启动：${error.message}`)));
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        try {
          const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          if (message.id === undefined) {
            return;
          }
          if (message.error !== undefined) {
            fail(new Error(message.error.message ?? 'MCP 调用失败'));
            return;
          }
          const resolvePending = pending.get(message.id);
          if (resolvePending !== undefined) {
            pending.delete(message.id);
            resolvePending(message.result);
          }
        } catch {
          fail(new Error('MCP 返回了无效 JSON'));
        }
      });
      void (async () => {
        try {
          await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'aiw', version: '0.1.0' } });
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          const result = await request(method, params);
          clearTimeout(timeout);
          child.kill();
          resolve(result);
        } catch (error) {
          fail(error instanceof Error ? error : new Error('MCP 调用失败'));
        }
      })();
    });
  }
}
