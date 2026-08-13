import { homedir } from 'node:os';
import { join } from 'node:path';

import type { McpClient } from '../ports/mcp-client.js';
import type { McpServerCatalog } from '../ports/mcp-server-catalog.js';
import type { McpServerDescriptor } from '../ports/mcp-server-config-resolver.js';
import { LocalConfig } from './local-config.js';

const DOCUMENT_TOOL = 'docx_v1_document_rawContent';

export type LarkConnectorDiscoveryResult =
  | { status: 'configured'; server: string; tool: string }
  | { status: 'ambiguous'; servers: string[] }
  | { status: 'already-configured' | 'not-found' | 'unsupported' | 'unavailable' };

/** Finds a single Lark MCP configured by Codex and stores only its non-secret local mapping. */
export class LarkConnectorAutoDiscovery {
  constructor(private readonly deps: {
    config: LocalConfig;
    catalog: McpServerCatalog;
    client: McpClient;
    codexConfigPath?: string;
  }) {}

  async discover(input: { server?: string } = {}): Promise<LarkConnectorDiscoveryResult> {
    if ((await this.deps.config.read()).connectors.lark !== undefined) {
      return { status: 'already-configured' };
    }
    let candidates: Array<{ name: string; descriptor: McpServerDescriptor }>;
    try {
      candidates = (await this.deps.catalog.list({
        source: 'codex-toml',
        path: this.deps.codexConfigPath ?? join(homedir(), '.codex', 'config.toml'),
      })).filter((candidate) => input.server === undefined ? isLarkCandidate(candidate) : candidate.name === input.server);
    } catch {
      return { status: 'unavailable' };
    }
    if (candidates.length === 0) {
      return { status: 'not-found' };
    }
    if (candidates.length > 1) {
      return { status: 'ambiguous', servers: candidates.map((candidate) => candidate.name) };
    }
    const candidate = candidates[0];
    try {
      if (this.deps.client.listTools === undefined) {
        return { status: 'unavailable' };
      }
      const tools = await this.deps.client.listTools({ server: candidate.descriptor });
      const documentTools = tools.filter((tool) => tool.name === DOCUMENT_TOOL);
      if (documentTools.length !== 1) {
        return { status: 'unsupported' };
      }
    } catch {
      return { status: 'unavailable' };
    }
    await this.deps.config.updateLarkConnector({
      configSource: { kind: 'codex-toml', path: this.deps.codexConfigPath ?? join(homedir(), '.codex', 'config.toml') },
      server: candidate.name,
      tool: DOCUMENT_TOOL,
      useUAT: false,
    });
    return { status: 'configured', server: candidate.name, tool: DOCUMENT_TOOL };
  }
}

function isLarkCandidate(input: { name: string; descriptor: { command: string; args: string[] } }): boolean {
  return /lark|feishu/i.test([input.name, input.descriptor.command, ...input.descriptor.args].join(' '));
}
