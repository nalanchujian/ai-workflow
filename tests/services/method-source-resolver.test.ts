import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { MethodSourceResolver } from '../../src/services/method-source-resolver.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('MethodSourceResolver', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('rejects configured method sources', async () => {
    const directory = await createTempDirectory('aiw-method-source-');
    directories.push(directory);
    const resolver = new MethodSourceResolver(new SkillRegistry(join(directory, 'registry.yaml')));

    await expect(resolver.resolve({ id: 'superpowers:brainstorming', source: 'configured:superpowers', version: '6.2.0' })).rejects.toThrow('Method source is unavailable');
  });

  it('reads a bundled method from the installed registry without local configuration', async () => {
    const directory = await createTempDirectory('aiw-method-source-');
    directories.push(directory);
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const source = {
      id: 'superpowers:brainstorming',
      source: 'bundled:superpowers',
      version: '6.2.0',
      revision: 'a'.repeat(40),
      sha256: 'b'.repeat(64),
    };
    await registry.replace({
      skills: [],
      profiles: [],
      methods: [{ source, content: '# bundled brainstorming\n', registrySource: { url: 'https://example.test/skills.git', revision: 'c'.repeat(40) } }],
    });
    const resolver = new MethodSourceResolver(registry);

    await expect(resolver.readLocked(source)).resolves.toEqual({ source, content: '# bundled brainstorming\n' });
  });
});
