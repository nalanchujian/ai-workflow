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
});
