import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LocalConfig } from '../../src/services/local-config.js';
import { MethodSourceResolver } from '../../src/services/method-source-resolver.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { createSkillRepositoryFixture } from '../helpers/skill-repository-fixture.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('MethodSourceResolver', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('locks the configured Superpowers method content by revision and hash', async () => {
    const directory = await createTempDirectory('aiw-method-source-');
    directories.push(directory);
    const { methodRoot } = await createSkillRepositoryFixture(directory);
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, `schemaVersion: aiw.local/v1\nmethodSources:\n  superpowers:\n    kind: local-skill-directory\n    root: ${methodRoot}\n    version: 6.2.0\n    revision: 6.2.0\n`);

    const resolved = await new MethodSourceResolver(new LocalConfig(configPath)).resolve({ id: 'superpowers:brainstorming', source: 'configured:superpowers', version: '6.2.0' });

    expect(resolved).toMatchObject({ id: 'superpowers:brainstorming', revision: '6.2.0', source: 'configured:superpowers' });
    expect(resolved.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a locked method when its local content changes', async () => {
    const directory = await createTempDirectory('aiw-method-source-');
    directories.push(directory);
    const { methodRoot } = await createSkillRepositoryFixture(directory);
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, `schemaVersion: aiw.local/v1\nmethodSources:\n  superpowers:\n    kind: local-skill-directory\n    root: ${methodRoot}\n    version: 6.2.0\n    revision: 6.2.0\n`);
    const resolver = new MethodSourceResolver(new LocalConfig(configPath));
    const resolved = await resolver.resolve({ id: 'superpowers:brainstorming', source: 'configured:superpowers', version: '6.2.0' });
    await writeFile(join(methodRoot, 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\n---\n\n# changed\n');

    await expect(resolver.assertLocked(resolved)).rejects.toThrow('方法来源内容已变化');
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
    const resolver = new MethodSourceResolver(new LocalConfig(join(directory, 'missing-config.yaml')), registry);

    await expect(resolver.readLocked(source)).resolves.toEqual({ source, content: '# bundled brainstorming\n' });
  });
});
