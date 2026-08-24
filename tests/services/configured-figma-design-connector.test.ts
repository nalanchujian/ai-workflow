import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

import { ConfiguredFigmaDesignConnector } from '../../src/services/configured-figma-design-connector.js';
import { LocalConfig } from '../../src/services/local-config.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('ConfiguredFigmaDesignConnector', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('uses the Figma MCP profile from local configuration', async () => {
    const directory = await createTempDirectory('aiw-configured-figma-');
    directories.push(directory);
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, `schemaVersion: aiw.local/v1
connectors:
  figma:
    configSource:
      kind: codex-toml
      path: /local/config.toml
    server: figma
    tools:
      metadata: get_metadata
      screenshot: get_screenshot
      designContext: get_design_context
`);
    const connector = new ConfiguredFigmaDesignConnector({
      config: new LocalConfig(configPath),
      client: { async callTool(input) {
        return input.tool === 'get_metadata'
          ? { content: [{ type: 'text', text: '<frame />' }] }
          : { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') }] };
      } },
      resolver: { async resolve() { return { transport: 'stdio', command: 'figma-mcp', args: [], env: {} }; } },
    });

    await expect(connector.captureRoot({ url: 'https://www.figma.com/design/file-key/name?node-id=1-2' }))
      .resolves.toMatchObject({ nodeId: '1:2', metadata: '<frame />' });
  });
});
