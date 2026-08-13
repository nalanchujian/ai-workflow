import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TaskInitializer } from '../../src/services/task-initializer.js';
import { TaskStore } from '../../src/services/task-store.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { ProjectRepositoryError } from '../../src/ports/project-repository.js';
import type { InstalledSkill } from '../../src/domain/skill.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('TaskInitializer', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('initializes a task only when the profile resolves and locks every executable stage', async () => {
    const projectRoot = await createTempDirectory('aiw-task-init-');
    directories.push(projectRoot);
    const registry = new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml'));
    await registry.replace({ skills: allSkills(), profiles: [profile()] });
    const store = new TaskStore(projectRoot);
    const initializer = new TaskInitializer({
      registry,
      projectRepository: { async assertProjectReady() {} },
      sourceIntakeFactory: () => ({
        async snapshot() { return { sourceId: 'requirements', kind: 'local-file', origin: 'requirements.md', revision: 1, fetchedAt: '2026-08-13T00:00:00.000Z', markdown: '# Refund', contentSha256: hash('# Refund'), extractor: 'local-file/requirements.md' }; },
        async writeSnapshot() { return { kind: 'local-file', origin: 'requirements.md', revision: 1, snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json', contentSha256: hash('# Refund') }; },
      }) as never,
      taskStoreFactory: () => store,
      now: () => new Date('2026-08-13T12:00:00.000Z'),
    });

    const task = await initializer.init({ projectRoot, source: join(projectRoot, 'requirements.md'), skillProfile: 'standard-web-feature@1.0.0' });

    expect(task.id).toBe('task-20260813-120000-000');
    expect(task.skillProfile.name).toBe('standard-web-feature');
    expect(task.nodes.intake.status).toBe('completed');
    expect(task.nodes.clarify.skill?.name).toBe('requirements-clarification');
    expect(task.nodes.test.skill?.name).toBe('acceptance-testing');
    expect((await store.load('task-20260813-120000-000')).sources.requirements.snapshotPath).toBe('sources/requirements/r1/snapshot.md');
    await expect(readFile(join(store.taskDirectory('task-20260813-120000-000'), 'task.md'), 'utf8')).resolves.toContain('需求来源：requirements.md');
    await expect(readFile(join(projectRoot, '.aiw', 'config.yaml'), 'utf8')).resolves.toContain('schemaVersion: aiw.config/v1');
  });

  it('does not create a task when the requested profile is missing', async () => {
    const projectRoot = await createTempDirectory('aiw-task-init-');
    directories.push(projectRoot);
    const store = new TaskStore(projectRoot);
    const initializer = new TaskInitializer({ registry: new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml')), projectRepository: { async assertProjectReady() {} }, sourceIntakeFactory: () => ({} as never), taskStoreFactory: () => store, now: () => new Date('2026-08-13T12:00:00.000Z') });

    await expect(initializer.init({ projectRoot, source: 'requirements.md', skillProfile: 'missing@1.0.0' })).rejects.toThrow('工作流模板不存在');
    await expect(readFile(join(store.taskDirectory('task-20260813-120000-000'), 'task.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects project admission before reading the source or creating a task directory', async () => {
    const projectRoot = await createTempDirectory('aiw-task-init-');
    directories.push(projectRoot);
    const registryRoot = await createTempDirectory('aiw-registry-');
    directories.push(registryRoot);
    const registry = new SkillRegistry(join(registryRoot, 'registry.yaml'));
    await registry.replace({ skills: allSkills(), profiles: [profile()] });
    const store = new TaskStore(projectRoot);
    let sourceRead = false;
    const initializer = new TaskInitializer({
      registry,
      projectRepository: { async assertProjectReady() { throw new ProjectRepositoryError('PROJECT_NOT_GIT', '不是 Git 工作树'); } },
      sourceIntakeFactory: () => ({ async snapshot() { sourceRead = true; throw new Error('不应读取来源'); } }) as never,
      taskStoreFactory: () => store,
      now: () => new Date('2026-08-13T12:00:00.000Z'),
    });

    await expect(initializer.init({ projectRoot, source: 'requirements.md', skillProfile: 'standard-web-feature@1.0.0' })).rejects.toThrow('不是 Git 工作树');
    expect(sourceRead).toBe(false);
    await expect(access(store.taskDirectory('task-20260813-120000-000'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(projectRoot, '.aiw', 'config.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(store.taskDirectory('task-20260813-120000-000'), 'task.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('routes multi-label Lark tenant domains to the Lark connector', async () => {
    const projectRoot = await createTempDirectory('aiw-task-init-');
    directories.push(projectRoot);
    const registry = new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml'));
    await registry.replace({ skills: allSkills(), profiles: [profile()] });
    const store = new TaskStore(projectRoot);
    let sourceInput: unknown;
    const initializer = new TaskInitializer({
      registry,
      projectRepository: { async assertProjectReady() {} },
      sourceIntakeFactory: () => ({
        async snapshot(input: unknown) {
          sourceInput = input;
          return { sourceId: 'requirements', kind: 'lark-document', origin: 'https://jphmzyvzr43.jp.larksuite.com/docx/doccn123', externalId: 'doccn123', revision: 1, fetchedAt: '2026-08-13T00:00:00.000Z', markdown: '# Requirement', contentSha256: hash('# Requirement'), extractor: 'lark-mcp/v1' };
        },
        async writeSnapshot() { return { kind: 'lark-document', origin: 'https://jphmzyvzr43.jp.larksuite.com/docx/doccn123', externalId: 'doccn123', revision: 1, snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json', contentSha256: hash('# Requirement') }; },
      }) as never,
      taskStoreFactory: () => store,
      now: () => new Date('2026-08-13T12:00:00.000Z'),
    });

    await initializer.init({
      projectRoot,
      source: 'https://jphmzyvzr43.jp.larksuite.com/docx/doccn123',
      sourceSection: '二期 (V2.3)',
      skillProfile: 'standard-web-feature@1.0.0',
    });

    expect(sourceInput).toMatchObject({ kind: 'lark-document', section: '二期 (V2.3)' });
  });
});

function profile() {
  return {
    name: 'standard-web-feature', version: '1.0.0', description: 'Standard web feature workflow', registrySource: { url: 'https://example.test/skills.git', revision: 'abc123' }, sha256: hash('profile'),
    skills: {
      clarify: 'requirements-clarification@1.0.0', solution: 'technical-solution@1.0.0', plan: 'implementation-planning@1.0.0', implement: 'typescript-web-implementation@1.0.0', verify: 'web-verification@1.0.0', test: 'acceptance-testing@1.0.0',
    },
  };
}

function allSkills(): InstalledSkill[] {
  return [
    ['requirements-clarification', 'clarify'], ['technical-solution', 'solution'], ['implementation-planning', 'plan'], ['typescript-web-implementation', 'implement'], ['web-verification', 'verify'], ['acceptance-testing', 'test'],
  ].map(([name, phase]) => ({
    name, version: '1.0.0', description: `${name} skill`, phases: [phase as InstalledSkill['phases'][number]], body: '# skill', registrySource: { url: 'https://example.test/skills.git', revision: 'abc123' }, sha256: hash(name),
    methodSources: [{ id: 'superpowers:brainstorming', source: 'bundled:superpowers', version: '6.2.0', revision: 'a'.repeat(40), sha256: hash(`method-${name}`) }],
  }));
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
