import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LocalConfig } from '../../src/services/local-config.js';
import { MethodSourceResolver } from '../../src/services/method-source-resolver.js';
import { SkillInstaller } from '../../src/services/skill-installer.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { createSkillRepositoryFixture } from '../helpers/skill-repository-fixture.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('SkillInstaller', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('installs skills, the workflow profile, revision locks and resolved methods atomically', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-');
    directories.push(directory);
    const { methodRoot, repository } = await createSkillRepositoryFixture(directory);
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, `schemaVersion: aiw.local/v1\nmethodSources:\n  superpowers:\n    kind: local-skill-directory\n    root: ${methodRoot}\n    version: 6.2.0\n    revision: 6.2.0\n`);
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const installer = new SkillInstaller({ git: { async clone() { return { directory: repository, revision: 'abc123' }; } }, methodSources: new MethodSourceResolver(new LocalConfig(configPath)), registry });

    const installed = await installer.install({ url: 'https://example.test/skills.git' });

    expect(installed.skills).toHaveLength(6);
    expect(installed.skills[0]).toMatchObject({ registrySource: { revision: 'abc123' } });
    expect(await registry.listProfiles()).toHaveLength(1);
  });

  it('does not mutate the registry when a method source is not configured', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-');
    directories.push(directory);
    const { methodRoot, repository } = await createSkillRepositoryFixture(directory);
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, `schemaVersion: aiw.local/v1\nmethodSources:\n  superpowers:\n    kind: local-skill-directory\n    root: ${methodRoot}\n    version: 6.2.0\n    revision: 6.2.0\n`);
    await writeFile(join(repository, 'skills', 'requirements-clarification', 'SKILL.md'), `---\nname: requirements-clarification\nversion: 1.0.0\ndescription: requirement skill\nphases: [clarify]\nmethodSources:\n  - id: superpowers:brainstorming\n    version: 6.2.0\n    source: configured:missing\n---\n\n# Requirement\n\n## 输入\n\n- input\n\n## 步骤\n\n1. step\n\n## 验证\n\n- verify\n`);
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const installer = new SkillInstaller({ git: { async clone() { return { directory: repository, revision: 'abc123' }; } }, methodSources: new MethodSourceResolver(new LocalConfig(configPath)), registry });

    await expect(installer.install({ url: 'https://example.test/skills.git' })).rejects.toThrow('Method source is unavailable');
    await expect(registry.list()).resolves.toEqual([]);
  });
});
