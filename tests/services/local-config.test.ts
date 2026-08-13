import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LocalConfig } from '../../src/services/local-config.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('LocalConfig', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('accepts connector-only configuration and rejects removed method-source profiles', async () => {
    const directory = await createTempDirectory('aiw-local-config-');
    directories.push(directory);
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, 'schemaVersion: aiw.local/v1\nconnectors: {}\n');

    await expect(new LocalConfig(configPath).read()).resolves.toMatchObject({ connectors: {} });
    await writeFile(configPath, 'schemaVersion: aiw.local/v1\nconnectors: {}\nmethodSources: {}\n');

    await expect(new LocalConfig(configPath).read()).rejects.toBeDefined();
  });

  it('returns and updates the configured default workflow only after callers request it', async () => {
    const directory = await createTempDirectory('aiw-local-config-');
    directories.push(directory);
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, `schemaVersion: aiw.local/v1
connectors: {}
workflow:
  defaultSkillSource:
    url: https://github.com/nalanchujian/ai-workflow-skills.git
    ref: v2.0.0
  defaultProfile: standard-web-feature@2.0.0
`);
    const config = new LocalConfig(configPath);

    await expect(config.defaultWorkflow()).resolves.toEqual({
      defaultSkillSource: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.0.0' },
      defaultProfile: 'standard-web-feature@2.0.0',
    });

    await config.updateDefaultWorkflowRef('v2.1.0');

    await expect(config.defaultWorkflow()).resolves.toMatchObject({ defaultSkillSource: { ref: 'v2.1.0' } });
  });
});
