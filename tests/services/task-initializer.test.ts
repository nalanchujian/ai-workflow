import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { InstalledSkill } from '../../src/domain/skill.js';
import type { InstalledWorkflowProfile } from '../../src/domain/workflow-profile.js';
import { ProjectRepositoryError } from '../../src/ports/project-repository.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { TaskInitializer } from '../../src/services/task-initializer.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('TaskInitializer', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('creates a task before collecting any requirement material', async () => {
    const projectRoot = await setupRoot(directories);
    const task = await createInitializer(projectRoot).init({ projectRoot, skillProfile: 'standard-web-feature' });

    expect(task.inputs).toEqual({ requirement: { status: 'not-asked' }, apiDocuments: { status: 'not-asked' }, design: { status: 'not-asked' } });
    expect(task.sources).toEqual({});
    expect(task.nodes).toMatchObject({
      'requirement-analysis': { title: '需求分析', status: 'ready', dependsOn: [], requiresApproval: true },
      'api-analysis': { status: 'pending', dependsOn: ['requirement-analysis'] },
      'design-slicing': { status: 'pending', dependsOn: ['api-analysis'] },
      solution: { status: 'pending', dependsOn: ['design-slicing'] },
    });
    expect(task.nodes).not.toHaveProperty('intake');
    expect(task.nodes).not.toHaveProperty('clarify');
    expect(task.nodes).not.toHaveProperty('api-document-recognition');
    await expect(readFile(join(projectRoot, '.aiw', 'config.yaml'), 'utf8')).resolves.toContain('schemaVersion: aiw.config/v1');
  });

  it('locks every skill bound to a phase in profile order', async () => {
    const projectRoot = await createTempDirectory('aiw-task-init-multiple-');
    directories.push(projectRoot);
    const registry = new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml'));
    const workflow = profile();
    workflow.skills.solution = ['technical-solution@1.0.0', 'solution-review@1.0.0'];
    await registry.replace({
      profiles: [workflow],
      skills: [...allSkills(), {
        name: 'solution-review', version: '1.0.0', description: 'review', aiwCompatibility: '>=0.0.1 <1.0.0', artifactContract: 'aiw.task-output/v2', phases: ['solution'], body: '# review', registrySource: workflow.registrySource, sha256: hash('solution-review'),
      }],
    });

    const task = await createInitializer(projectRoot).init({ projectRoot, skillProfile: workflow.name });

    expect(task.nodes.solution?.skills.map((skill) => skill.name)).toEqual(['technical-solution', 'solution-review']);
  });

  it('does not require a requirement URL during initialization', async () => {
    const projectRoot = await setupRoot(directories);
    const initializer = createInitializer(projectRoot);
    await expect(initializer.init({ projectRoot, skillProfile: 'standard-web-feature' })).resolves.toBeDefined();
  });

  it('checks repository admission before creating a task', async () => {
    const projectRoot = await setupRoot(directories);
    const registry = new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml'));
    const initializer = new TaskInitializer({
      registry,
      projectRepository: { async assertProjectReady() { throw new ProjectRepositoryError('PROJECT_NOT_GIT', '不是 Git 工作树'); } },
      taskStoreFactory: (root) => new TaskStore(root),
    });
    await expect(initializer.init({ projectRoot, skillProfile: 'standard-web-feature' })).rejects.toThrow('不是 Git 工作树');
  });
});

async function setupRoot(directories: string[]): Promise<string> {
  const root = await createTempDirectory('aiw-task-init-');
  directories.push(root);
  const registry = new SkillRegistry(join(root, '.aiw', 'registry.yaml'));
  await registry.replace({ skills: allSkills(), profiles: [profile()] });
  return root;
}

function createInitializer(projectRoot: string): TaskInitializer {
  return new TaskInitializer({
    registry: new SkillRegistry(join(projectRoot, '.aiw', 'registry.yaml')),
    projectRepository: { async assertProjectReady() {} },
    taskStoreFactory: (root) => new TaskStore(root),
    now: () => new Date('2026-09-08T12:00:00.000Z'),
  });
}

function profile(): InstalledWorkflowProfile {
  return {
    name: 'standard-web-feature', description: 'Standard web feature workflow', aiwCompatibility: '>=0.0.1 <1.0.0', artifactContract: 'aiw.task-output/v2', registrySource: { url: 'https://example.test/skills.git', revision: 'abc123' }, sha256: hash('profile'),
    skills: {
      'api-analysis': ['api-analysis@1.0.0'], 'design-slicing': ['design-slicing@1.0.0'], 'requirement-analysis': ['requirement-analysis@1.0.0'], solution: ['technical-solution@1.0.0'], plan: ['implementation-planning@1.0.0'], development: ['typescript-web-implementation@1.0.0'],
    },
  };
}

function allSkills(): InstalledSkill[] {
  return [['api-analysis', 'api-analysis'], ['design-slicing', 'design-slicing'], ['requirement-analysis', 'requirement-analysis'], ['technical-solution', 'solution'], ['implementation-planning', 'plan'], ['typescript-web-implementation', 'development']]
    .map(([name, phase]) => ({ name, version: '1.0.0', description: `${name} skill`, aiwCompatibility: '>=0.0.1 <1.0.0' as const, artifactContract: 'aiw.task-output/v2' as const, phases: [phase as InstalledSkill['phases'][number]], body: '# skill', registrySource: { url: 'https://example.test/skills.git', revision: 'abc123' }, sha256: hash(name) }));
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
