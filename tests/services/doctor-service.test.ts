import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DoctorService } from '../../src/services/doctor-service.js';
import { LocalConfig } from '../../src/services/local-config.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('DoctorService', () => {
  const directories: string[] = [];

  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('reports Git, Codex, configured method sources, and Lark configuration without testing Lark authorization by default', async () => {
    const directory = await createConfiguredDirectory(directories);
    const result = await new DoctorService({
      config: new LocalConfig(join(directory, 'config.yaml')),
      projectRepository: { async assertProjectReady() {} },
      processRunner: successfulProcessRunner(),
      mcpServerConfigResolver: { async resolve() { return { transport: 'stdio', command: 'lark-mcp', args: [], env: {} }; } },
      mcpClient: { async callTool() { return { data: { content: '# requirements' } }; } },
    }).inspect({ projectRoot: directory, codexBin: 'codex' });

    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'git-cli', status: 'passed' }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'project-repository', status: 'passed' }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'codex-cli', status: 'passed' }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'method-source:superpowers', status: 'passed' }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'lark-configuration', status: 'passed' }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'lark-authorization', status: 'warning' }));
  });

  it('uses an explicitly supplied Lark document only to verify Lark authorization', async () => {
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
      },
    }).inspect({ projectRoot: directory, codexBin: 'codex', larkUrl: 'https://acme.larksuite.com/docx/doccn123' });

    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'lark-authorization', status: 'passed' }));
    expect(receivedArguments).toEqual({ path: { document_id: 'doccn123' }, params: { lang: 0 }, useUAT: false });
    expect(JSON.stringify(result)).not.toContain('# requirements');
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
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'lark-authorization', status: 'warning' }));
  });
});

async function createConfiguredDirectory(directories: string[]): Promise<string> {
  const directory = await createTempDirectory('aiw-doctor-');
  directories.push(directory);
  const methodsRoot = join(directory, 'methods');
  await mkdir(join(methodsRoot, 'brainstorming'), { recursive: true });
  await writeFile(join(methodsRoot, 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\n---\n', 'utf8');
  await writeFile(join(directory, 'config.yaml'), [
    'schemaVersion: aiw.local/v1',
    'methodSources:',
    '  superpowers:',
    '    kind: local-skill-directory',
    `    root: ${methodsRoot}`,
    '    version: 6.2.0',
    '    revision: 6.2.0',
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
