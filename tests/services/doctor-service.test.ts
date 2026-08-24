import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DoctorService } from '../../src/services/doctor-service.js';
import { LocalConfig } from '../../src/services/local-config.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('DoctorService', () => {
  const directories: string[] = [];

  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('reports Git, Codex, bundled-method status, and document connector configuration without testing document authorization by default', async () => {
    const directory = await createConfiguredDirectory(directories);
    const result = await new DoctorService({
      config: new LocalConfig(join(directory, 'config.yaml')),
      projectRepository: { async assertProjectReady() {} },
      processRunner: successfulProcessRunner(),
      mcpServerConfigResolver: { async resolve() { return { transport: 'stdio', command: 'lark-mcp', args: [], env: {} }; } },
      mcpClient: { async callTool() { return { data: { content: '# requirements' } }; }, async listTools() { return [{ name: 'docx_v1_document_rawContent' }, { name: 'docx_v1_documentBlock_list' }]; } },
    }).inspect({ projectRoot: directory, codexBin: 'codex' });

    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'git-cli', status: 'passed' }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'project-repository', status: 'passed' }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'codex-cli', status: 'passed' }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'local-configuration',
      label: 'AIW 本机设置',
      message: '默认工作流和文档连接器设置有效。',
      status: 'passed',
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'method-sources', status: 'warning' }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'document-connector-configuration', label: '文档连接器配置', status: 'passed' }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'document-authorization', label: '文档读取授权', status: 'warning' }));
  });

  it('uses an explicitly supplied connected document only to verify its read authorization', async () => {
    const directory = await createConfiguredDirectory(directories);
    let receivedArguments: unknown;
    const result = await new DoctorService({
      config: new LocalConfig(join(directory, 'config.yaml')),
      projectRepository: { async assertProjectReady() {} },
      processRunner: successfulProcessRunner(),
      mcpServerConfigResolver: { async resolve() { return { transport: 'stdio', command: 'lark-mcp', args: [], env: {} }; } },
      mcpClient: {
        async callTool(input) {
          receivedArguments = input.arguments;
          return { data: { content: '# requirements' } };
        },
        async listTools() { return [{ name: 'docx_v1_document_rawContent' }, { name: 'docx_v1_documentBlock_list' }]; },
      },
    }).inspect({ projectRoot: directory, codexBin: 'codex', source: 'https://acme.larksuite.com/docx/doccn123' });

    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'document-authorization', label: '文档读取授权', status: 'passed' }));
    expect(receivedArguments).toEqual({ path: { document_id: 'doccn123' }, params: { lang: 0 }, useUAT: false });
    expect(JSON.stringify(result)).not.toContain('# requirements');
  });

  it('accepts connector-only configuration when bundled methods are installed', async () => {
    const directory = await createTempDirectory('aiw-doctor-');
    directories.push(directory);
    await writeFile(join(directory, 'config.yaml'), 'schemaVersion: aiw.local/v1\nconnectors: {}\n', 'utf8');
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    await registry.replace({
      skills: [],
      profiles: [],
      methods: [{
        source: { id: 'superpowers:brainstorming', source: 'bundled:superpowers', version: '6.2.0', revision: 'a'.repeat(40), sha256: 'b'.repeat(64) },
        content: '# brainstorming\n',
        registrySource: { url: 'https://example.test/skills.git', revision: 'c'.repeat(40) },
      }],
    });

    const result = await new DoctorService({
      config: new LocalConfig(join(directory, 'config.yaml')),
      registry,
      projectRepository: { async assertProjectReady() {} },
      processRunner: successfulProcessRunner(),
    }).inspect({ projectRoot: directory, codexBin: 'codex' });

    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'method-sources', status: 'passed' }));
  });

  it('checks the optional Figma MCP tools before a design-analysis task is run', async () => {
    const directory = await createTempDirectory('aiw-doctor-figma-');
    directories.push(directory);
    await writeFile(join(directory, 'config.yaml'), [
      'schemaVersion: aiw.local/v1',
      'connectors:',
      '  figma:',
      '    configSource:',
      '      kind: codex-toml',
      `      path: ${join(directory, 'codex.toml')}`,
      '    server: figma',
      '    tools:',
      '      metadata: get_metadata',
      '      screenshot: get_screenshot',
      '      designContext: get_design_context',
      '',
    ].join('\n'), 'utf8');
    const result = await new DoctorService({
      config: new LocalConfig(join(directory, 'config.yaml')),
      projectRepository: { async assertProjectReady() {} },
      processRunner: successfulProcessRunner(),
      mcpServerConfigResolver: { async resolve() { return { transport: 'stdio', command: 'figma-mcp', args: [], env: {} }; } },
      mcpClient: { async callTool() { return {}; }, async listTools() { return [{ name: 'get_metadata' }, { name: 'get_screenshot' }, { name: 'get_design_context' }]; } },
    }).inspect({ projectRoot: directory, codexBin: 'codex' });

    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'design-connector-configuration', status: 'passed' }));
  });

  it('reports a configuration failure before task creation when block listing is unavailable', async () => {
    const directory = await createConfiguredDirectory(directories);
    const result = await new DoctorService({
      config: new LocalConfig(join(directory, 'config.yaml')),
      projectRepository: { async assertProjectReady() {} }, processRunner: successfulProcessRunner(),
      mcpServerConfigResolver: { async resolve() { return { transport: 'stdio', command: 'lark-mcp', args: [], env: {} }; } },
      mcpClient: { async callTool() { return { data: { content: '# requirements' } }; }, async listTools() { return [{ name: 'docx_v1_document_rawContent' }]; } },
    }).inspect({ projectRoot: directory, codexBin: 'codex' });

    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'document-connector-configuration', status: 'failed', message: expect.stringContaining('docx_v1_documentBlock_list') }));
  });

  it('returns actionable failures instead of throwing when the local configuration is invalid', async () => {
    const directory = await createTempDirectory('aiw-doctor-');
    directories.push(directory);
    await writeFile(join(directory, 'config.yaml'), 'schemaVersion: invalid\nmethodSources: [not-a-map]\n', 'utf8');

    const result = await new DoctorService({
      config: new LocalConfig(join(directory, 'config.yaml')),
      projectRepository: { async assertProjectReady() { throw new Error('not a repository'); } },
      processRunner: successfulProcessRunner(),
    }).inspect({ projectRoot: directory, codexBin: 'codex' });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'local-configuration', status: 'failed', suggestion: expect.stringContaining('~/.aiw/config.yaml') }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'project-repository', status: 'failed' }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'method-sources', status: 'warning' }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'document-authorization', status: 'warning' }));
  });
});

async function createConfiguredDirectory(directories: string[]): Promise<string> {
  const directory = await createTempDirectory('aiw-doctor-');
  directories.push(directory);
  await writeFile(join(directory, 'config.yaml'), [
    'schemaVersion: aiw.local/v1',
    'connectors:',
    '  lark:',
    '    configSource:',
    '      kind: codex-toml',
    `      path: ${join(directory, 'codex.toml')}`,
    '    server: lark-openapi',
    '    tool: docx_v1_document_rawContent',
    '    useUAT: false',
    '',
  ].join('\n'), 'utf8');
  return directory;
}

function successfulProcessRunner() {
  return {
    async run() {
      return { exitCode: 0, signal: null, stdout: 'version', stderr: '', timedOut: false };
    },
  };
}
