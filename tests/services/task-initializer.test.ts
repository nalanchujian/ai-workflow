import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
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

  it('copies multiple exported images into task facts and schedules design binding after the plan', async () => {
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

    await writeFile(join(projectRoot, 'main.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'));
    await writeFile(join(projectRoot, 'details.jpg'), Buffer.from('ffd8ff000000', 'hex'));
    const task = await initializer.init({
      projectRoot,
      source: 'requirements.md',
      designImages: ['main.png', 'details.jpg'],
      skillProfile: 'standard-web-feature',
    });

    expect(task.designInput).toEqual({
      provider: 'local-images',
      images: [
        { id: 'main', originalName: 'main.png', imagePath: 'sources/design/main.png', mediaType: 'image/png' },
        { id: 'details', originalName: 'details.jpg', imagePath: 'sources/design/details.jpg', mediaType: 'image/jpeg' },
      ],
    });
    expect(task.nodes['design-analysis']).toMatchObject({
      phase: 'design',
      status: 'pending',
      dependsOn: ['plan'],
      outputs: [
        'artifacts/design/design-assets.yaml',
      ],
    });
    expect(task.nodes.clarify).toMatchObject({ status: 'ready', dependsOn: ['intake'] });
    await expect(readFile(join(store.taskDirectory(task.id), 'sources/design/main.png'))).resolves.toEqual(Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  });

  it('rejects missing and unsupported design images before creating a task', async () => {
    const projectRoot = await createTempDirectory('aiw-task-init-');
    directories.push(projectRoot);
    const registry = new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml'));
    await registry.replace({ skills: allSkills(), profiles: [profile()] });
    const initializer = new TaskInitializer({
      registry,
      projectRepository: { async assertProjectReady() {} },
      sourceIntakeFactory: () => ({
        async snapshot() { return { sourceId: 'requirements', kind: 'local-file', origin: 'requirements.md', revision: 1, fetchedAt: '2026-08-13T00:00:00.000Z', markdown: '# Refund', extractor: 'local-file/requirements.md' }; },
        async writeSnapshot() { return { kind: 'local-file', origin: 'requirements.md', revision: 1, snapshotPath: 'sources/requirements/r1/snapshot.md', metaPath: 'sources/requirements/r1/meta.json' }; },
      }) as never,
      taskStoreFactory: () => new TaskStore(projectRoot),
    });
    await expect(initializer.init({ projectRoot, source: 'requirements.md', designImages: ['missing.png'], skillProfile: 'standard-web-feature' }))
      .rejects.toThrow(/无法读取设计图片/);
    await writeFile(join(projectRoot, 'notes.txt'), 'not an image');
    await expect(initializer.init({ projectRoot, source: 'requirements.md', designImages: ['notes.txt'], skillProfile: 'standard-web-feature' }))
      .rejects.toThrow(/仅支持 PNG\/JPEG/);
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

  it('recognizes batch YApi documents before clarification and attaches every snapshot to the task', async () => {
    const projectRoot = await createTempDirectory('aiw-task-init-');
    directories.push(projectRoot);
    const registry = new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml'));
    await registry.replace({ skills: allSkills(), profiles: [profile()] });
    const store = new TaskStore(projectRoot);
    const snapshotInputs: Array<{ sourceId: string; value: string }> = [];
    const initializer = new TaskInitializer({
      registry,
      projectRepository: { async assertProjectReady() {} },
      sourceIntakeFactory: () => ({
        async snapshot(input: { sourceId: string; value: string }) {
          snapshotInputs.push(input);
          const isApi = input.sourceId.startsWith('api-document-');
          return {
            sourceId: input.sourceId,
            kind: isApi ? 'connected-document' : 'local-file',
            origin: input.value,
            ...(isApi ? { externalId: input.sourceId.replace('api-document-', '') } : {}),
            revision: 1,
            fetchedAt: '2026-08-13T00:00:00.000Z',
            markdown: isApi ? '# 接口' : '# 需求',
            extractor: isApi ? 'yapi-interface-api/v1' : 'local-file/requirements.md',
          };
        },
        async writeSnapshot(input: { snapshot: { sourceId: string; kind: 'connected-document' | 'local-file'; origin: string; externalId?: string } }) {
          const { sourceId, kind, origin, externalId } = input.snapshot;
          return { kind, origin, ...(externalId === undefined ? {} : { externalId }), revision: 1, snapshotPath: `sources/${sourceId}/r1/snapshot.md`, metaPath: `sources/${sourceId}/r1/meta.json` };
        },
      }) as never,
      taskStoreFactory: () => store,
      now: () => new Date('2026-08-13T12:00:00.000Z'),
    });

    const task = await initializer.init({
      projectRoot,
      source: 'requirements.md',
      apiDocumentIds: ['17879,17884', '17904,17879'],
      skillProfile: 'standard-web-feature',
    });

    expect(snapshotInputs).toEqual([
      { sourceId: 'requirements', value: 'requirements.md', revision: 1 },
      { sourceId: 'api-document-17879', value: 'https://yapi.hbdev.club/project/149/interface/api/17879', revision: 1 },
      { sourceId: 'api-document-17884', value: 'https://yapi.hbdev.club/project/149/interface/api/17884', revision: 1 },
      { sourceId: 'api-document-17904', value: 'https://yapi.hbdev.club/project/149/interface/api/17904', revision: 1 },
    ]);
    expect(Object.keys(task.sources)).toEqual(['requirements', 'api-document-17879', 'api-document-17884', 'api-document-17904']);
    expect(task.nodes['api-document-recognition']).toMatchObject({
      phase: 'intake', status: 'completed', dependsOn: ['intake'],
      outputs: [
        'sources/api-document-17879/r1/snapshot.md', 'sources/api-document-17879/r1/meta.json',
        'sources/api-document-17884/r1/snapshot.md', 'sources/api-document-17884/r1/meta.json',
        'sources/api-document-17904/r1/snapshot.md', 'sources/api-document-17904/r1/meta.json',
      ],
    });
    expect(task.nodes.clarify).toMatchObject({ status: 'ready', dependsOn: ['api-document-recognition'] });
  });
});

function profile(): InstalledWorkflowProfile {
  return {
    name: 'standard-web-feature', description: 'Standard web feature workflow', aiwCompatibility: '>=0.0.1 <1.0.0', artifactContract: 'aiw.task-output/v1', registrySource: { url: 'https://example.test/skills.git', revision: 'abc123' }, sha256: hash('profile'),
    skills: {
      design: 'design-image-segmentation@1.0.0', clarify: 'requirements-clarification@1.0.0', solution: 'technical-solution@1.0.0', plan: 'implementation-planning@1.0.0', development: 'typescript-web-implementation@1.0.0',
    },
  };
}

function allSkills(): InstalledSkill[] {
  return [
    ['design-image-segmentation', 'design'], ['requirements-clarification', 'clarify'], ['technical-solution', 'solution'], ['implementation-planning', 'plan'], ['typescript-web-implementation', 'development'],
  ].map(([name, phase]) => ({
    name, version: '1.0.0', description: `${name} skill`, aiwCompatibility: '>=0.0.1 <1.0.0', artifactContract: 'aiw.task-output/v1', phases: [phase as InstalledSkill['phases'][number]], body: '# skill', registrySource: { url: 'https://example.test/skills.git', revision: 'abc123' }, sha256: hash(name),
    methodSources: [{ id: 'superpowers:brainstorming', source: 'bundled:superpowers', version: '6.2.0', revision: 'a'.repeat(40), sha256: hash(`method-${name}`) }],
  }));
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
