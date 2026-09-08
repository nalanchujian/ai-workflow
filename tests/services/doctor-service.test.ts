import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DoctorService } from '../../src/services/doctor-service.js';
import { LocalConfig } from '../../src/services/local-config.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('DoctorService', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('checks a configured Lark OpenAPI connector without MCP', async () => {
    const directory = await configuredDirectory(directories);
    const result = await new DoctorService({ config: new LocalConfig(join(directory, 'config.yaml')), projectRepository: { async assertProjectReady() {} }, processRunner: successfulProcessRunner(), network: successfulNetwork() }).inspect({ projectRoot: directory, codexBin: 'codex', source: 'https://acme.larksuite.com/docx/doccn123' });
    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'document-connector-configuration', status: 'passed', message: 'Lark OpenAPI 应用配置有效。' }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'document-authorization', status: 'passed', message: '指定文档可通过 Lark OpenAPI 读取。' }));
  });

  it('reports invalid local configuration without throwing', async () => {
    const directory = await createTempDirectory('aiw-doctor-');
    directories.push(directory);
    await writeFile(join(directory, 'config.yaml'), 'schemaVersion: invalid\nconnectors: {}\n', 'utf8');
    const result = await new DoctorService({ config: new LocalConfig(join(directory, 'config.yaml')), projectRepository: { async assertProjectReady() { throw new Error('not a repository'); } }, processRunner: successfulProcessRunner(), network: successfulNetwork() }).inspect({ projectRoot: directory, codexBin: 'codex' });
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'local-configuration', status: 'failed' }));
  });

  it('identifies missing Lark OpenAPI scopes', async () => {
    const directory = await configuredDirectory(directories);
    const result = await new DoctorService({
      config: new LocalConfig(join(directory, 'config.yaml')),
      projectRepository: { async assertProjectReady() {} },
      processRunner: successfulProcessRunner(),
      network: { async fetch(input: { url: string; method?: string }) { return input.method === 'POST' ? { body: JSON.stringify({ code: 0, tenant_access_token: 'token' }), contentType: 'application/json', status: 200, url: input.url } : { body: JSON.stringify({ code: 99991672 }), contentType: 'application/json', status: 400, url: input.url }; }, async resolve() { return ['8.8.8.8']; } },
    }).inspect({ projectRoot: directory, codexBin: 'codex', source: 'https://acme.larksuite.com/wiki/DJJXwQUSui36aEkFz8QjwPRTp8e' });
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'document-authorization', status: 'failed', message: 'Lark OpenAPI 缺少 Wiki 读取权限，请在应用中授权、发布并完成审批' }));
  });
});

async function configuredDirectory(directories: string[]): Promise<string> {
  const directory = await createTempDirectory('aiw-doctor-');
  directories.push(directory);
  await writeFile(join(directory, 'config.yaml'), ['schemaVersion: aiw.local/v1', 'connectors:', '  lark:', '    appId: cli_test', '    appSecret: secret', '    domain: https://open.larksuite.com', ''].join('\n'), 'utf8');
  return directory;
}

function successfulProcessRunner() { return { async run() { return { exitCode: 0, signal: null, stdout: 'version', stderr: '', timedOut: false }; } }; }
function successfulNetwork() { return { async fetch(input: { url: string; method?: string }) { return input.method === 'POST' ? { body: JSON.stringify({ code: 0, tenant_access_token: 'token' }), contentType: 'application/json', status: 200, url: input.url } : { body: JSON.stringify({ code: 0, data: { has_more: false, items: [{ block_id: 'root', block_type: 2, text: { elements: [{ text_run: { content: '需求' } }] } }] } }), contentType: 'application/json', status: 200, url: input.url }; }, async resolve() { return ['8.8.8.8']; } }; }
