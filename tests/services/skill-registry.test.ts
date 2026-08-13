import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { SkillRegistry } from '../../src/services/skill-registry.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('SkillRegistry', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('returns an empty registry before the first install', async () => {
    const directory = await createTempDirectory('aiw-skill-registry-');
    directories.push(directory);

    await expect(new SkillRegistry(join(directory, 'registry.yaml')).list()).resolves.toEqual([]);
  });
});
