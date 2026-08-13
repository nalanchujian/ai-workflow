import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
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

  it('installs a source that contains skills but no workflow profiles', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-');
    directories.push(directory);
    const { methodRoot, repository } = await createSkillRepositoryFixture(directory);
    await rm(join(repository, 'profiles'), { recursive: true, force: true });
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, `schemaVersion: aiw.local/v1\nmethodSources:\n  superpowers:\n    kind: local-skill-directory\n    root: ${methodRoot}\n    version: 6.2.0\n    revision: 6.2.0\n`);
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const installer = new SkillInstaller({ git: { async clone() { return { directory: repository, revision: 'abc123' }; } }, methodSources: new MethodSourceResolver(new LocalConfig(configPath)), registry });

    const installed = await installer.install({ url: 'https://example.test/skills-only.git' });

    expect(installed.skills).toHaveLength(6);
    expect(installed.profiles).toEqual([]);
  });

  it('installs a profile-only source when its referenced skills are already installed', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-');
    directories.push(directory);
    const { methodRoot, repository } = await createSkillRepositoryFixture(directory);
    const profileRepository = join(directory, 'profiles-only');
    await mkdir(join(profileRepository, 'profiles', 'standard-web-feature'), { recursive: true });
    await copyFile(join(repository, 'profiles', 'standard-web-feature', 'PROFILE.yaml'), join(profileRepository, 'profiles', 'standard-web-feature', 'PROFILE.yaml'));
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, `schemaVersion: aiw.local/v1\nmethodSources:\n  superpowers:\n    kind: local-skill-directory\n    root: ${methodRoot}\n    version: 6.2.0\n    revision: 6.2.0\n`);
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const installer = new SkillInstaller({
      git: { async clone(input) { return input.url.endsWith('profiles-only.git') ? { directory: profileRepository, revision: 'profile-revision' } : { directory: repository, revision: 'skills-revision' }; } },
      methodSources: new MethodSourceResolver(new LocalConfig(configPath)),
      registry,
    });
    await installer.install({ url: 'https://example.test/skills.git' });

    const installed = await installer.install({ url: 'https://example.test/profiles-only.git' });

    expect(installed.skills).toEqual([]);
    expect(installed.profiles).toHaveLength(1);
    expect(await registry.list()).toHaveLength(6);
  });
});
