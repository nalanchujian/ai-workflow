import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SkillRegistry } from '../../src/services/skill-registry.js';
import type { InstalledSkill } from '../../src/domain/skill.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('SkillRegistry', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('returns an empty registry before the first install', async () => {
    const directory = await createTempDirectory('aiw-skill-registry-');
    directories.push(directory);
    await expect(new SkillRegistry(join(directory, 'registry.yaml')).list()).resolves.toEqual([]);
  });

  it('replaces skills and profiles from the same team source', async () => {
    const directory = await createTempDirectory('aiw-skill-registry-');
    directories.push(directory);
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    await registry.replaceSource({ sourceUrl: 'https://example.test/skills.git', skills: [skill('old')], profiles: [] });
    await registry.replaceSource({ sourceUrl: 'https://example.test/skills.git', skills: [skill('current')], profiles: [] });
    await expect(registry.list()).resolves.toEqual([expect.objectContaining({ name: 'current' })]);
  });

  it('requires reinstalling a registry created by an older application version', async () => {
    const directory = await createTempDirectory('aiw-skill-registry-');
    directories.push(directory);
    const path = join(directory, 'registry.yaml');
    await writeFile(path, 'schemaVersion: aiw.skill-registry/v2\nskills: []\nprofiles: []\nmethods: []\n', 'utf8');
    await expect(new SkillRegistry(path).list()).rejects.toThrow('输出契约不兼容');
  });
});

function skill(name: string): InstalledSkill {
  return {
    name, version: '1.0.0', description: name, aiwCompatibility: '>=0.0.1 <1.0.0' as const,
    artifactContract: 'aiw.task-output/v2' as const, phases: ['requirement-analysis'], body: '# skill',
    registrySource: { url: 'https://example.test/skills.git', revision: `${name[0]}${'a'.repeat(39)}` }, sha256: 'b'.repeat(64),
  };
}
