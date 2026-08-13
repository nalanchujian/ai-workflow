import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SkillInstaller } from '../../src/services/skill-installer.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { createBundledSkillRepositoryFixture } from '../helpers/skill-repository-fixture.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('SkillInstaller', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('installs skills, the workflow profile, revision locks and resolved methods atomically', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-');
    directories.push(directory);
    const { repository } = await createBundledSkillRepositoryFixture(directory);
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const installer = new SkillInstaller({ git: { async clone() { return { directory: repository, revision: 'abc123' }; } }, registry });

    const installed = await installer.install({ url: 'https://example.test/skills.git' });

    expect(installed.skills).toHaveLength(6);
    expect(installed.skills[0]).toMatchObject({ registrySource: { revision: 'abc123' } });
    expect(await registry.listProfiles()).toHaveLength(1);
  });

  it('installs bundled methods without a local Superpowers configuration', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-');
    directories.push(directory);
    const { repository } = await createBundledSkillRepositoryFixture(directory);
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const installer = new SkillInstaller({
      git: { async clone() { return { directory: repository, revision: 'b'.repeat(40) }; } },
      registry,
    });

    const installed = await installer.install({ url: 'https://example.test/skills.git' });

    expect(installed.methods).toHaveLength(3);
    expect(installed.skills).toHaveLength(6);
    await expect(registry.listMethods()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: expect.objectContaining({ source: 'bundled:superpowers', id: 'superpowers:brainstorming' }) }),
    ]));
  });

  it('rejects an invalid bundled reference without changing the Registry', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-');
    directories.push(directory);
    const { repository } = await createBundledSkillRepositoryFixture(directory);
    await writeFile(join(repository, 'skills', 'requirements-clarification', 'SKILL.md'), `---\nname: requirements-clarification\nversion: 2.0.0\ndescription: invalid reference\nphases: [clarify]\nmethodSources:\n  - id: superpowers:missing-method\n    version: 6.2.0\n    source: bundled:superpowers\n---\n\n# Requirement\n\n## 输入\n\n- input\n\n## 步骤\n\n1. step\n\n## 验证\n\n- verify\n`);
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const installer = new SkillInstaller({
      git: { async clone() { return { directory: repository, revision: 'b'.repeat(40) }; } },
      registry,
    });

    await expect(installer.install({ url: 'https://example.test/skills.git' })).rejects.toThrow('未提供声明的方法来源');
    await expect(registry.list()).resolves.toEqual([]);
    await expect(registry.listMethods()).resolves.toEqual([]);
  });

  it('rejects configured method sources without a compatibility fallback', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-');
    directories.push(directory);
    const { repository } = await createBundledSkillRepositoryFixture(directory);
    await writeFile(join(repository, 'skills', 'requirements-clarification', 'SKILL.md'), `---\nname: requirements-clarification\nversion: 1.0.0\ndescription: requirement skill\nphases: [clarify]\nmethodSources:\n  - id: superpowers:brainstorming\n    version: 6.2.0\n    source: configured:missing\n---\n\n# Requirement\n\n## 输入\n\n- input\n\n## 步骤\n\n1. step\n\n## 验证\n\n- verify\n`);
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const installer = new SkillInstaller({ git: { async clone() { return { directory: repository, revision: 'abc123' }; } }, registry });

    await expect(installer.install({ url: 'https://example.test/skills.git' })).rejects.toThrow('只支持内置方法来源');
    await expect(registry.list()).resolves.toEqual([]);
  });

  it('installs a source that contains skills but no workflow profiles', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-');
    directories.push(directory);
    const { repository } = await createBundledSkillRepositoryFixture(directory);
    await rm(join(repository, 'profiles'), { recursive: true, force: true });
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const installer = new SkillInstaller({ git: { async clone() { return { directory: repository, revision: 'abc123' }; } }, registry });

    const installed = await installer.install({ url: 'https://example.test/skills-only.git' });

    expect(installed.skills).toHaveLength(6);
    expect(installed.profiles).toEqual([]);
  });

  it('installs a profile-only source when its referenced skills are already installed', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-');
    directories.push(directory);
    const { repository } = await createBundledSkillRepositoryFixture(directory);
    const profileRepository = join(directory, 'profiles-only');
    await mkdir(join(profileRepository, 'profiles', 'standard-web-feature'), { recursive: true });
    await copyFile(join(repository, 'profiles', 'standard-web-feature', 'PROFILE.yaml'), join(profileRepository, 'profiles', 'standard-web-feature', 'PROFILE.yaml'));
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const installer = new SkillInstaller({
      git: { async clone(input) { return input.url.endsWith('profiles-only.git') ? { directory: profileRepository, revision: 'profile-revision' } : { directory: repository, revision: 'skills-revision' }; } },
      registry,
    });
    await installer.install({ url: 'https://example.test/skills.git' });

    const installed = await installer.install({ url: 'https://example.test/profiles-only.git' });

    expect(installed.skills).toEqual([]);
    expect(installed.profiles).toHaveLength(1);
    expect(await registry.list()).toHaveLength(6);
  });

  it('rejects a source that contains neither skills nor workflow profiles', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-');
    directories.push(directory);
    const repository = join(directory, 'empty-repository');
    await mkdir(repository, { recursive: true });
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const installer = new SkillInstaller({ git: { async clone() { return { directory: repository, revision: 'abc123' }; } }, registry });

    await expect(installer.install({ url: 'https://example.test/empty.git' })).rejects.toThrow('未包含有效技能或工作流模板');
    await expect(registry.list()).resolves.toEqual([]);
    await expect(registry.listProfiles()).resolves.toEqual([]);
  });
});
