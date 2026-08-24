import { describe, expect, it } from 'vitest';

import { FigmaDesignConnector } from '../../src/services/figma-design-connector.js';

describe('FigmaDesignConnector', () => {
  it('reads metadata and a PNG overview for a Figma root node', async () => {
    const calls: Array<{ tool: string; arguments: unknown }> = [];
    const connector = new FigmaDesignConnector({
      client: { async callTool(input) {
        calls.push({ tool: input.tool, arguments: input.arguments });
        return input.tool === 'get_metadata'
          ? { content: [{ type: 'text', text: '<frame id="9272:292811" name="Overview" />' }] }
          : { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') }] };
      } },
      resolver: { async resolve() { return { transport: 'stdio', command: 'figma-mcp', args: [], env: {} }; } },
      config: {
        configPath: '/local/config.toml', server: 'figma',
        tools: { metadata: 'get_metadata', screenshot: 'get_screenshot', designContext: 'get_design_context' },
      },
    });

    const result = await connector.captureRoot({
      url: 'https://www.figma.com/design/vcORdd4C9qEqW1YIYfbzl7/Infloww?node-id=9272-292810&m=dev',
    });

    expect(result).toMatchObject({
      fileKey: 'vcORdd4C9qEqW1YIYfbzl7', nodeId: '9272:292810',
      metadata: '<frame id="9272:292811" name="Overview" />', screenshot: Buffer.from('png'),
    });
    expect(calls).toEqual([
      { tool: 'get_metadata', arguments: { fileKey: 'vcORdd4C9qEqW1YIYfbzl7', nodeId: '9272:292810' } },
      { tool: 'get_screenshot', arguments: { fileKey: 'vcORdd4C9qEqW1YIYfbzl7', nodeId: '9272:292810' } },
    ]);
  });

  it('reads scoped context and screenshot for one child node', async () => {
    const connector = new FigmaDesignConnector({
      client: { async callTool(input) {
        return input.tool === 'get_design_context'
          ? { content: [{ type: 'text', text: '<design>context</design>' }] }
          : { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('child').toString('base64') }] };
      } },
      resolver: { async resolve() { return { transport: 'stdio', command: 'figma-mcp', args: [], env: {} }; } },
      config: {
        configPath: '/local/config.toml', server: 'figma',
        tools: { metadata: 'get_metadata', screenshot: 'get_screenshot', designContext: 'get_design_context' },
      },
    });

    await expect(connector.captureNode({
      url: 'https://www.figma.com/design/file-key/Infloww?node-id=9272-292810',
      nodeId: '9272:292811',
    })).resolves.toEqual({ designContext: '<design>context</design>', screenshot: Buffer.from('child') });
  });

  it('rejects unsupported URLs and invalid MCP responses without exposing credentials', async () => {
    const connector = new FigmaDesignConnector({
      client: { async callTool() { throw new Error('token=secret'); } },
      resolver: { async resolve() { return { transport: 'stdio', command: 'figma-mcp', args: [], env: {} }; } },
      config: {
        configPath: '/local/config.toml', server: 'figma',
        tools: { metadata: 'get_metadata', screenshot: 'get_screenshot', designContext: 'get_design_context' },
      },
    });

    await expect(connector.captureRoot({ url: 'https://example.com/design/123' }))
      .rejects.toMatchObject({ code: 'FIGMA_URL_UNSUPPORTED' });
    await expect(connector.captureRoot({ url: 'https://www.figma.com/design/file-key/name?node-id=1-2' }))
      .rejects.toMatchObject({ code: 'FIGMA_MCP_UNAVAILABLE', message: 'Figma MCP 不可用' });
  });
});
