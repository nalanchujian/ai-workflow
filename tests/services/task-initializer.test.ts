import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TaskInitializer } from '../../src/services/task-initializer.js';
import { TaskStore } from '../../src/services/task-store.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { ProjectRepositoryError } from '../../src/ports/project-repository.js';
import type { InstalledSkill } from '../../src/domain/skill.js';
import type { InstalledWorkflowProfile } from '../../src/domain/workflow-profile.js';
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
        async snapshot() { return { sourceId: 'requirements', kind: 'local-file', origin: 'requirements.md', revision: 1, fetchedAt: '2026-08-13T00:00:00.000Z', markdown: '# Refund', extractor: 'local-file/requirements.md' }; },
        async writeSnapshot() { return { kind: 'local-file', origin: 'requirements.md', revision: 1, snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json' }; },
      }) as never,
      taskStoreFactory: () => store,
      now: () => new Date('2026-08-13T12:00:00.000Z'),
    });

    const task = await initializer.init({ projectRoot, source: join(projectRoot, 'requirements.md'), skillProfile: 'standard-web-feature' });

    expect(task.id).toBe('task-20260813-120000-000');
    expect(task.repository).toBe('.');
    expect(task.skillProfile.name).toBe('standard-web-feature');
    expect(task.nodes.intake.status).toBe('completed');
    expect(task.nodes['design-analysis']).toBeUndefined();
    expect(task.nodes.clarify.skill?.name).toBe('requirements-clarification');
    expect(task.nodes.clarify.outputs).toEqual(['artifacts/clarify/fact-register.yaml', 'artifacts/clarify/decision-register.yaml']);
    expect(task.nodes.solution.outputs).toEqual(['artifacts/solution/solution.md']);
    expect(task.nodes.plan.outputs).toEqual(['artifacts/plan/development-plan.yaml']);
    expect(task.developmentSkill.name).toBe('typescript-web-implementation');
    expect((await store.load('task-20260813-120000-000')).sources.requirements.snapshotPath).toBe('sources/requirements/r1/snapshot.md');
    await expect(readFile(join(projectRoot, '.aiw', 'config.yaml'), 'utf8')).resolves.toContain('schemaVersion: aiw.config/v1');
  });

  it('registers an optional design-analysis node without reading Figma during task initialization', async () => {
    const projectRoot = await createTempDirectory('aiw-task-init-');
    directories.push(projectRoot);
    const registry = new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml'));
    await registry.replace({ skills: allSkills(), profiles: [profile()] });
    const store = new TaskStore(projectRoot);
    const initializer = new TaskInitializer({
      registry,
      projectRepository: { async assertProjectReady() {} },
      sourceIntakeFactory: () => ({
        async snapshot() { return { sourceId: 'requirements', kind: 'local-file', origin: 'requirements.md', revision: 1, fetchedAt: '2026-08-13T00:00:00.000Z', markdown: '# Refund', extractor: 'local-file/requirements.md' }; },
        async writeSnapshot() { return { kind: 'local-file', origin: 'requirements.md', revision: 1, snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json' }; },
      }) as never,
      taskStoreFactory: () => store,
      now: () => new Date('2026-08-13T12:00:00.000Z'),
    });

    const task = await initializer.init({
      projectRoot,
      source: 'requirements.md',
      design: 'https://www.figma.com/design/vcORdd4C9qEqW1YIYfbzl7/Infloww?node-id=9272-292810&m=dev',
      skillProfile: 'standard-web-feature',
    });

    expect(task.designInput).toEqual({
      provider: 'figma',
      url: 'https://www.figma.com/design/vcORdd4C9qEqW1YIYfbzl7/Infloww?node-id=9272-292810&m=dev',
      fileKey: 'vcORdd4C9qEqW1YIYfbzl7',
      nodeId: '9272:292810',
    });
    expect(task.nodes['design-analysis']).toMatchObject({
      phase: 'design',
      status: 'ready',
      dependsOn: ['intake'],
      outputs: [
        'artifacts/design/design-catalog.yaml',
        'artifacts/design/design-rules.yaml',
        'artifacts/design/design-context.md',
      ],
    });
    expect(task.nodes.clarify).toMatchObject({ status: 'pending', dependsOn: ['design-analysis'] });
  });

  it('keeps profiles without a design skill usable for tasks that do not request design analysis', async () => {
    const projectRoot = await createTempDirectory('aiw-task-init-');
    directories.push(projectRoot);
    const registry = new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml'));
    const current = profile();
    const skills = { ...current.skills };
    delete skills.design;
    await registry.replace({ skills: allSkills(), profiles: [{ ...current, skills }] });
    const store = new TaskStore(projectRoot);
    const initializer = new TaskInitializer({
      registry,
      projectRepository: { async assertProjectReady() {} },
      sourceIntakeFactory: () => ({
        async snapshot() { return { sourceId: 'requirements', kind: 'local-file', origin: 'requirements.md', revision: 1, fetchedAt: '2026-08-13T00:00:00.000Z', markdown: '# Refund', extractor: 'local-file/requirements.md' }; },
        async writeSnapshot() { return { kind: 'local-file', origin: 'requirements.md', revision: 1, snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json' }; },
      }) as never,
      taskStoreFactory: () => store,
      now: () => new Date('2026-08-13T12:00:00.000Z'),
    });

    await expect(initializer.init({ projectRoot, source: 'requirements.md', skillProfile: 'standard-web-feature' }))
      .resolves.toMatchObject({ nodes: { clarify: { status: 'ready' } } });
  });

  it('resolves skills from the selected workflow profile revision', async () => {
    const projectRoot = await createTempDirectory('aiw-task-init-');
    directories.push(projectRoot);
    const registry = new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml'));
    const selectedSource = { url: 'https://example.test/skills.git', revision: 'b'.repeat(40) };
    const selectedSkills = allSkills().map((skill) => ({
      ...skill,
      registrySource: selectedSource,
      sha256: hash(`selected-${skill.name}`),
    }));
    const selectedProfile = {
      ...profile(),
      registrySource: selectedSource,
      sha256: hash('selected-profile'),
    };
    await registry.replace({ skills: selectedSkills, profiles: [selectedProfile] });
    const store = new TaskStore(projectRoot);
    const initializer = new TaskInitializer({
      registry,
      projectRepository: { async assertProjectReady() {} },
      sourceIntakeFactory: () => ({
        async snapshot() { return { sourceId: 'requirements', kind: 'local-file', origin: 'requirements.md', revision: 1, fetchedAt: '2026-08-13T00:00:00.000Z', markdown: '# Refund', extractor: 'local-file/requirements.md' }; },
        async writeSnapshot() { return { kind: 'local-file', origin: 'requirements.md', revision: 1, snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json' }; },
      }) as never,
      taskStoreFactory: () => store,
      now: () => new Date('2026-08-13T12:00:00.000Z'),
    });

    const task = await initializer.init({ projectRoot, source: 'requirements.md', skillProfile: 'standard-web-feature' });

    expect(task.developmentSkill.registrySource).toEqual(selectedSource);
    expect(task.developmentSkill.sha256).toBe(hash('selected-typescript-web-implementation'));
  });

  it('rejects an unfinished task with the same normalized requirement before reading the source again', async () => {
    const projectRoot = await createTempDirectory('aiw-task-init-');
    directories.push(projectRoot);
    const registry = new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml'));
    await registry.replace({ skills: allSkills(), profiles: [profile()] });
    const store = new TaskStore(projectRoot);
    let sourceReads = 0;
    let milliseconds = 0;
    const initializer = new TaskInitializer({
      registry,
      projectRepository: { async assertProjectReady() {} },
      sourceIntakeFactory: () => ({
        async snapshot() {
          sourceReads += 1;
          return { sourceId: 'requirements', kind: 'local-file', origin: 'requirements.md', revision: 1, fetchedAt: '2026-08-13T00:00:00.000Z', markdown: '# Refund', extractor: 'local-file/requirements.md' };
        },
        async writeSnapshot() { return { kind: 'local-file', origin: 'requirements.md', revision: 1, snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json' }; },
      }) as never,
      taskStoreFactory: () => store,
      now: () => new Date(Date.parse('2026-08-13T12:00:00.000Z') + milliseconds++),
    });

    await initializer.init({ projectRoot, source: join(projectRoot, 'requirements.md'), skillProfile: 'standard-web-feature' });

    await expect(initializer.init({ projectRoot, source: 'requirements.md', skillProfile: 'standard-web-feature' }))
      .rejects.toThrow('已存在相同需求的未完成任务：task-20260813-120000-000');
    expect(sourceReads).toBe(1);
  });

  it('allows an explicit force-new request to initialize another task for the same requirement', async () => {
    const projectRoot = await createTempDirectory('aiw-task-init-');
    directories.push(projectRoot);
    const registry = new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml'));
    await registry.replace({ skills: allSkills(), profiles: [profile()] });
    const store = new TaskStore(projectRoot);
    let milliseconds = 0;
    const initializer = new TaskInitializer({
      registry,
      projectRepository: { async assertProjectReady() {} },
      sourceIntakeFactory: () => ({
        async snapshot() { return { sourceId: 'requirements', kind: 'local-file', origin: 'requirements.md', revision: 1, fetchedAt: '2026-08-13T00:00:00.000Z', markdown: '# Refund', extractor: 'local-file/requirements.md' }; },
        async writeSnapshot() { return { kind: 'local-file', origin: 'requirements.md', revision: 1, snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json' }; },
      }) as never,
      taskStoreFactory: () => store,
      now: () => new Date(Date.parse('2026-08-13T12:00:00.000Z') + milliseconds++),
    });

    await initializer.init({ projectRoot, source: 'requirements.md', skillProfile: 'standard-web-feature' });
    const task = await initializer.init({ projectRoot, source: 'requirements.md', skillProfile: 'standard-web-feature', forceNew: true });

    expect(task.id).toBe('task-20260813-120000-001');
  });

  it('allows a new task after the earlier task has no unfinished nodes', async () => {
    const projectRoot = await createTempDirectory('aiw-task-init-');
    directories.push(projectRoot);
    const registry = new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml'));
    await registry.replace({ skills: allSkills(), profiles: [profile()] });
    const store = new TaskStore(projectRoot);
    let milliseconds = 0;
    const initializer = new TaskInitializer({
      registry,
      projectRepository: { async assertProjectReady() {} },
      sourceIntakeFactory: () => ({
        async snapshot() { return { sourceId: 'requirements', kind: 'local-file', origin: 'requirements.md', revision: 1, fetchedAt: '2026-08-13T00:00:00.000Z', markdown: '# Refund', extractor: 'local-file/requirements.md' }; },
        async writeSnapshot() { return { kind: 'local-file', origin: 'requirements.md', revision: 1, snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json' }; },
      }) as never,
      taskStoreFactory: () => store,
      now: () => new Date(Date.parse('2026-08-13T12:00:00.000Z') + milliseconds++),
    });

    const earlier = await initializer.init({ projectRoot, source: 'requirements.md', skillProfile: 'standard-web-feature' });
    for (const node of Object.values(earlier.nodes)) {
      node.status = 'completed';
    }
    await store.update(earlier);

    await expect(initializer.init({ projectRoot, source: 'requirements.md', skillProfile: 'standard-web-feature' }))
      .resolves.toMatchObject({ id: 'task-20260813-120000-001' });
  });

  it('does not create a task when the requested profile is missing', async () => {
    const projectRoot = await createTempDirectory('aiw-task-init-');
    directories.push(projectRoot);
    const store = new TaskStore(projectRoot);
    const initializer = new TaskInitializer({ registry: new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml')), projectRepository: { async assertProjectReady() {} }, sourceIntakeFactory: () => ({} as never), taskStoreFactory: () => store, now: () => new Date('2026-08-13T12:00:00.000Z') });

    await expect(initializer.init({ projectRoot, source: 'requirements.md', skillProfile: 'missing' })).rejects.toThrow('工作流模板不存在');
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

    await expect(initializer.init({ projectRoot, source: 'requirements.md', skillProfile: 'standard-web-feature' })).rejects.toThrow('不是 Git 工作树');
    expect(sourceRead).toBe(false);
    await expect(access(store.taskDirectory('task-20260813-120000-000'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(projectRoot, '.aiw', 'config.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(store.taskDirectory('task-20260813-120000-000'), 'task.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('forwards a generic source request and section selector to the source intake', async () => {
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
          return { sourceId: 'requirements', kind: 'connected-document', origin: 'https://jphmzyvzr43.jp.larksuite.com/docx/doccn123', externalId: 'doccn123', revision: 1, fetchedAt: '2026-08-13T00:00:00.000Z', markdown: '# Requirement', extractor: 'lark-mcp/v1' };
        },
        async writeSnapshot() { return { kind: 'connected-document', origin: 'https://jphmzyvzr43.jp.larksuite.com/docx/doccn123', externalId: 'doccn123', revision: 1, snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json' }; },
      }) as never,
      taskStoreFactory: () => store,
      now: () => new Date('2026-08-13T12:00:00.000Z'),
    });

    await initializer.init({
      projectRoot,
      source: 'https://jphmzyvzr43.jp.larksuite.com/docx/doccn123',
      section: '二期 (V2.3)',
      skillProfile: 'standard-web-feature',
    });

    expect(sourceInput).toEqual({ sourceId: 'requirements', value: 'https://jphmzyvzr43.jp.larksuite.com/docx/doccn123', section: '二期 (V2.3)', revision: 1 });
  });
});

function profile(): InstalledWorkflowProfile {
  return {
    name: 'standard-web-feature', description: 'Standard web feature workflow', aiwCompatibility: '>=0.0.1 <1.0.0', artifactContract: 'aiw.task-output/v1', registrySource: { url: 'https://example.test/skills.git', revision: 'abc123' }, sha256: hash('profile'),
    skills: {
      design: 'figma-design-analysis@1.0.0', clarify: 'requirements-clarification@1.0.0', solution: 'technical-solution@1.0.0', plan: 'implementation-planning@1.0.0', development: 'typescript-web-implementation@1.0.0',
    },
  };
}

function allSkills(): InstalledSkill[] {
  return [
    ['figma-design-analysis', 'design'], ['requirements-clarification', 'clarify'], ['technical-solution', 'solution'], ['implementation-planning', 'plan'], ['typescript-web-implementation', 'development'],
  ].map(([name, phase]) => ({
    name, version: '1.0.0', description: `${name} skill`, aiwCompatibility: '>=0.0.1 <1.0.0', artifactContract: 'aiw.task-output/v1', phases: [phase as InstalledSkill['phases'][number]], body: '# skill', registrySource: { url: 'https://example.test/skills.git', revision: 'abc123' }, sha256: hash(name),
    methodSources: [{ id: 'superpowers:brainstorming', source: 'bundled:superpowers', version: '6.2.0', revision: 'a'.repeat(40), sha256: hash(`method-${name}`) }],
  }));
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
