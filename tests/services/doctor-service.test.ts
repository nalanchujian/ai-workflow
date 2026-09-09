import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DoctorService } from '../../src/services/doctor-service.js';
import { LarkSourceConnectorError } from '../../src/services/lark-source-connector.js';
import { LocalConfig } from '../../src/services/local-config.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('DoctorService', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('checks a configured direct Lark user-identity connector', async () => {
    const directory = await configuredDirectory(directories);
    const result = await new DoctorService({ config: new LocalConfig(join(directory, 'config.yaml')), projectRepository: { async assertProjectReady() {} }, processRunner: successfulProcessRunner(), connector: successfulConnector() }).inspect({ projectRoot: directory, codexBin: 'codex', source: 'https://acme.larksuite.com/docx/doccn123' });
    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'document-connector-configuration', status: 'passed', message: 'Lark 用户身份读取配置有效。' }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'document-authorization', status: 'passed', message: '指定文档可通过用户身份读取。' }));
  });

  it('reports invalid local configuration without throwing', async () => {
    const directory = await createTempDirectory('aiw-doctor-');
    directories.push(directory);
    await writeFile(join(directory, 'config.yaml'), 'schemaVersion: invalid\nconnectors: {}\n', 'utf8');
    const result = await new DoctorService({ config: new LocalConfig(join(directory, 'config.yaml')), projectRepository: { async assertProjectReady() { throw new Error('not a repository'); } }, processRunner: successfulProcessRunner(), connector: successfulConnector() }).inspect({ projectRoot: directory, codexBin: 'codex' });
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'local-configuration', status: 'failed' }));
  });

  it('reports an expired Lark user login', async () => {
    const directory = await configuredDirectory(directories);
    const result = await new DoctorService({
      config: new LocalConfig(join(directory, 'config.yaml')),
      projectRepository: { async assertProjectReady() {} },
      processRunner: successfulProcessRunner(),
      connector: { supports() { return true; }, async fetch() { throw new LarkSourceConnectorError('LARK_AUTH_EXPIRED', 'Lark Connector 登录状态已失效，请重新授权后重试'); } },
    }).inspect({ projectRoot: directory, codexBin: 'codex', source: 'https://acme.larksuite.com/wiki/DJJXwQUSui36aEkFz8QjwPRTp8e' });
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'document-authorization', status: 'failed', message: 'Lark Connector 登录状态已失效，请重新授权后重试' }));
  });
});

async function configuredDirectory(directories: string[]): Promise<string> {
  const directory = await createTempDirectory('aiw-doctor-');
  directories.push(directory);
  await writeFile(join(directory, 'config.yaml'), ['schemaVersion: aiw.local/v1', 'connectors:', '  lark:', '    appId: cli_xxx', '    domain: https://open.larksuite.com', '    callback:', '      host: 127.0.0.1', '      port: 38991', ''].join('\n'), 'utf8');
  return directory;
}

function successfulProcessRunner() { return { async run() { return { exitCode: 0, signal: null, stdout: 'version', stderr: '', timedOut: false }; } }; }
function successfulConnector() { return { supports() { return true; }, async fetch() { return { canonicalUrl: 'https://acme.larksuite.com/docx/doccn123', externalId: 'doccn123', fetchedAt: new Date().toISOString(), markdown: '需求', extractor: 'lark-user-openapi/v1' }; } }; }
