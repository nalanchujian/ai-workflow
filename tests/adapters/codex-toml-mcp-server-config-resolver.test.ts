import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CodexTomlMcpServerConfigResolver } from '../../src/adapters/codex-toml-mcp-server-config-resolver.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('CodexTomlMcpServerConfigResolver', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(removeTempDirectory));
  });

  it('reads only the selected configured MCP server descriptor', async () => {
    const directory = await createTempDirectory('aiw-codex-toml-');
    directories.push(directory);
    const path = join(directory, 'config.toml');
    await writeFile(path, [
      '[mcp_servers.unrelated]',
      'command = "ignore-me"',
      'args = []',
      '',
      '[mcp_servers.lark-openapi]',
      'command = "npx"',
      'args = ["-y", "lark-mcp"]',
      'env = { LARK_APP_ID = "app-id", LARK_APP_SECRET = "app-secret" }',
    ].join('\n'));

    const descriptor = await new CodexTomlMcpServerConfigResolver().resolve({ source: 'codex-toml', path, server: 'lark-openapi' });

    expect(descriptor).toEqual({
      args: ['-y', 'lark-mcp'],
      command: 'npx',
      env: { LARK_APP_ID: 'app-id', LARK_APP_SECRET: 'app-secret' },
      transport: 'stdio',
    });
  });

  it('lists only top-level MCP servers and ignores nested configuration sections', async () => {
    const directory = await createTempDirectory('aiw-codex-toml-');
    directories.push(directory);
    const path = join(directory, 'config.toml');
    await writeFile(path, [
      '[mcp_servers.lark-openapi]',
      'command = "npx"',
      'args = ["-y", "lark-mcp"]',
      '',
      '[mcp_servers.lark-openapi.env]',
      'LARK_APP_ID = "app-id"',
    ].join('\n'));

    await expect(new CodexTomlMcpServerConfigResolver().list({ source: 'codex-toml', path }))
      .resolves.toMatchObject([{ name: 'lark-openapi', descriptor: { command: 'npx', args: ['-y', 'lark-mcp'] } }]);
  });
});
