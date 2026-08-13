import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LarkConnectorAutoDiscovery } from '../../src/services/lark-connector-auto-discovery.js';
import { LocalConfig } from '../../src/services/local-config.js';

describe('LarkConnectorAutoDiscovery', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  });

  it('writes a Lark connector from the only matching Codex MCP server and document tool', async () => {
    const path = await configPath(directories);
    const config = new LocalConfig(path);
    const discovery = new LarkConnectorAutoDiscovery({
      catalog: {
        async list() {
          return [
            { name: 'github', descriptor: descriptor('github-mcp') },
            { name: 'lark-openapi', descriptor: descriptor('lark-mcp') },
          ];
        },
      },
      client: {
        async listTools() {
          return [{ name: 'docx_v1_document_rawContent' }, { name: 'docx_v1_documentBlock_list' }];
        },
      },
      config,
    } as never);

    await expect(discovery.discover()).resolves.toEqual({ status: 'configured', server: 'lark-openapi', tool: 'docx_v1_document_rawContent' });
    await expect(config.larkConnector()).resolves.toEqual({
      configSource: { kind: 'codex-toml', path: '/Users/j/.codex/config.toml' },
      server: 'lark-openapi',
      tool: 'docx_v1_document_rawContent',
      useUAT: false,
    });
  });

  it('does not guess when multiple Lark MCP servers are configured', async () => {
    const path = await configPath(directories);
    const discovery = new LarkConnectorAutoDiscovery({
      catalog: {
        async list() {
          return [
            { name: 'lark-production', descriptor: descriptor('lark-mcp') },
            { name: 'lark-uat', descriptor: descriptor('lark-mcp') },
          ];
        },
      },
      client: { async listTools() { throw new Error('不应查询工具'); } },
      config: new LocalConfig(path),
    } as never);

    await expect(discovery.discover()).resolves.toEqual({ status: 'ambiguous', servers: ['lark-production', 'lark-uat'] });
    await expect(readFile(path, 'utf8')).resolves.toContain('connectors: {}');
  });

  it('uses an explicitly selected Lark server when multiple candidates exist', async () => {
    const path = await configPath(directories);
    const discovery = new LarkConnectorAutoDiscovery({
      catalog: {
        async list() {
          return [
            { name: 'lark-production', descriptor: descriptor('lark-mcp') },
            { name: 'lark-uat', descriptor: descriptor('lark-mcp') },
          ];
        },
      },
      client: { async listTools() { return [{ name: 'docx_v1_document_rawContent' }, { name: 'docx_v1_documentBlock_list' }]; } },
      config: new LocalConfig(path),
    } as never);

    await expect(discovery.discover({ server: 'lark-uat' })).resolves.toEqual({ status: 'configured', server: 'lark-uat', tool: 'docx_v1_document_rawContent' });
  });

  it('preserves an existing Lark connector without reconfiguring it', async () => {
    const path = await configPath(directories);
    await writeFile(path, [
      'schemaVersion: aiw.local/v1',
      'connectors:',
      '  lark:',
      '    configSource:',
      '      kind: codex-toml',
      '      path: /custom/config.toml',
      '    server: custom-lark',
      '    tool: custom-document-reader',
      '    useUAT: true',
      '',
    ].join('\n'));
    const discovery = new LarkConnectorAutoDiscovery({
      catalog: { async list() { throw new Error('不应读取 Codex 配置'); } },
      client: { async listTools() { throw new Error('不应查询工具'); } },
      config: new LocalConfig(path),
    } as never);

    await expect(discovery.discover()).resolves.toEqual({ status: 'already-configured' });
    await expect(new LocalConfig(path).larkConnector()).resolves.toMatchObject({ server: 'custom-lark', useUAT: true });
  });

  it('rejects a Lark MCP that cannot list document blocks for section reading', async () => {
    const path = await configPath(directories);
    const discovery = new LarkConnectorAutoDiscovery({
      catalog: { async list() { return [{ name: 'lark-openapi', descriptor: descriptor('lark-mcp') }]; } },
      client: { async listTools() { return [{ name: 'docx_v1_document_rawContent' }]; } },
      config: new LocalConfig(path),
    } as never);

    await expect(discovery.discover()).resolves.toEqual({ status: 'unsupported' });
  });
});

async function configPath(directories: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aiw-lark-discovery-'));
  directories.push(directory);
  const path = join(directory, 'config.yaml');
  await writeFile(path, 'schemaVersion: aiw.local/v1\nconnectors: {}\n');
  return path;
}

function descriptor(command: string) {
  return { args: [], command, env: {}, transport: 'stdio' as const };
}
