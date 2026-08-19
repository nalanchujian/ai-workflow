import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LocalInitializer } from '../../src/services/local-initializer.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('LocalInitializer', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('creates a documented connector and default-workflow template without overwriting it', async () => {
    const directory = await createTempDirectory('aiw-local-init-');
    directories.push(directory);
    const initializer = new LocalInitializer(join(directory, 'config.yaml'));

    await expect(initializer.init()).resolves.toEqual({ schemaVersion: 'aiw.init/v1', status: 'created', configPath: join(directory, 'config.yaml') });
    await expect(readFile(join(directory, 'config.yaml'), 'utf8')).resolves.toContain('connectors: {}');
    await expect(readFile(join(directory, 'config.yaml'), 'utf8')).resolves.toContain('defaultProfile: standard-web-feature@11.0.0');
    await expect(readFile(join(directory, 'config.yaml'), 'utf8')).resolves.toContain('maxTokens: 20000');
    await expect(readFile(join(directory, 'config.yaml'), 'utf8')).resolves.not.toContain('methodSources:');
    await expect(initializer.init()).resolves.toEqual({ schemaVersion: 'aiw.init/v1', status: 'already-initialized', configPath: join(directory, 'config.yaml') });
  });
});
