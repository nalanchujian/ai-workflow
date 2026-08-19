import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
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

  it('retains bundled methods from every installed revision of the same team source', async () => {
    const directory = await createTempDirectory('aiw-skill-registry-');
    directories.push(directory);
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const first = bundledMethod('https://example.test/first.git', 'a');
    const second = bundledMethod('https://example.test/second.git', 'b');

    await registry.replace({ skills: [], profiles: [], methods: [first, second] });
    await registry.replaceSource({ sourceUrl: 'https://example.test/first.git', skills: [], profiles: [], methods: [bundledMethod('https://example.test/first.git', 'c')] });

    await expect(registry.listMethods()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ registrySource: expect.objectContaining({ url: 'https://example.test/second.git' }) }),
      expect.objectContaining({ registrySource: expect.objectContaining({ url: 'https://example.test/first.git', revision: 'a'.repeat(40) }) }),
      expect.objectContaining({ registrySource: expect.objectContaining({ url: 'https://example.test/first.git', revision: 'c'.repeat(40) }) }),
    ]));
  });

  it('explains that a registry created by an older application version needs a skill update', async () => {
    const directory = await createTempDirectory('aiw-skill-registry-');
    directories.push(directory);
    const path = join(directory, 'registry.yaml');
    await writeFile(path, 'schemaVersion: aiw.skill-registry/v1\nskills: []\nprofiles: []\n', 'utf8');

    await expect(new SkillRegistry(path).list()).rejects.toThrow('输出契约不兼容');
  });
});

function bundledMethod(url: string, revisionCharacter: string) {
  return {
    source: {
      id: 'superpowers:brainstorming',
      source: 'bundled:superpowers',
      version: '6.2.0',
      revision: 'd'.repeat(40),
      sha256: 'e'.repeat(64),
    },
    content: '---\nname: brainstorming\n---\n\n# Brainstorming\n',
    registrySource: { url, revision: revisionCharacter.repeat(40) },
  };
}
