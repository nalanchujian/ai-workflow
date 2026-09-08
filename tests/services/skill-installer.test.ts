import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SkillInstaller } from '../../src/services/skill-installer.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { createBundledSkillRepositoryFixture } from '../helpers/skill-repository-fixture.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('SkillInstaller', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('installs only custom skills and their workflow profile atomically', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-'); directories.push(directory);
    const { repository } = await createBundledSkillRepositoryFixture(directory);
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const installed = await new SkillInstaller({ git: { async clone() { return { directory: repository, revision: 'abc123' }; } }, registry }).install({ url: 'https://example.test/skills.git' });
    expect(installed.skills).toHaveLength(6);
    expect(installed.profiles[0]?.skills.solution).toEqual(['technical-solution@2.0.0']);
    await expect(registry.list()).resolves.toHaveLength(6);
  });

  it('accepts multiple custom skills bound to one phase in profile order', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-'); directories.push(directory);
    const { repository } = await createBundledSkillRepositoryFixture(directory);
    const source = await readFile(join(repository, 'skills', 'technical-solution', 'SKILL.md'), 'utf8');
    await mkdir(join(repository, 'skills', 'solution-review'), { recursive: true });
    await writeFile(join(repository, 'skills', 'solution-review', 'SKILL.md'), source.replace('name: technical-solution', 'name: solution-review'));
    const profilePath = join(repository, 'profiles', 'standard-web-feature', 'PROFILE.yaml');
    await writeFile(profilePath, (await readFile(profilePath, 'utf8')).replace('solution: [technical-solution@2.0.0]', 'solution: [technical-solution@2.0.0, solution-review@2.0.0]'));
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    const installed = await new SkillInstaller({ git: { async clone() { return { directory: repository, revision: 'abc123' }; } }, registry }).install({ url: 'https://example.test/skills.git' });
    expect(installed.profiles[0]?.skills.solution).toEqual(['technical-solution@2.0.0', 'solution-review@2.0.0']);
  });

  it('rejects a skill that declares an external method source', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-'); directories.push(directory);
    const { repository } = await createBundledSkillRepositoryFixture(directory);
    const skillPath = join(repository, 'skills', 'requirement-analysis', 'SKILL.md');
    await writeFile(skillPath, (await readFile(skillPath, 'utf8')).replace('phases: [requirement-analysis]', 'phases: [requirement-analysis]\nmethodSources: []'));
    const registry = new SkillRegistry(join(directory, 'registry.yaml'));
    await expect(new SkillInstaller({ git: { async clone() { return { directory: repository, revision: 'abc123' }; } }, registry }).install({ url: 'https://example.test/skills.git' }))
      .rejects.toThrow('不支持第三方方法来源');
  });

  it('installs a source containing skills but no profile', async () => {
    const directory = await createTempDirectory('aiw-skill-installer-'); directories.push(directory);
    const { repository } = await createBundledSkillRepositoryFixture(directory);
    await rm(join(repository, 'profiles'), { recursive: true, force: true });
    const installed = await new SkillInstaller({ git: { async clone() { return { directory: repository, revision: 'abc123' }; } }, registry: new SkillRegistry(join(directory, 'registry.yaml')) }).install({ url: 'https://example.test/skills.git' });
    expect(installed.profiles).toEqual([]);
  });
});
