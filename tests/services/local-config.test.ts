import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LocalConfig } from '../../src/services/local-config.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('LocalConfig', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('reads an explicit local method source profile without discovering other paths', async () => {
    const directory = await createTempDirectory('aiw-local-config-');
    directories.push(directory);
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, `schemaVersion: aiw.local/v1\nmethodSources:\n  superpowers:\n    kind: local-skill-directory\n    root: ${directory}/methods\n    version: 6.2.0\n    revision: 6.2.0\n`);

    const profile = await new LocalConfig(configPath).methodSource('superpowers');

    expect(profile).toMatchObject({ kind: 'local-skill-directory', revision: '6.2.0', version: '6.2.0' });
    expect(profile.root).toBe(join(directory, 'methods'));
  });
});
