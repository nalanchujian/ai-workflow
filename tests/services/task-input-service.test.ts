import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { InstalledSkill } from '../../src/domain/skill.js';
import type { InstalledWorkflowProfile } from '../../src/domain/workflow-profile.js';
import { SkillRegistry } from '../../src/services/skill-registry.js';
import { TaskInputService } from '../../src/services/task-input-service.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

describe('TaskInputService', () => {
  it('records that no API document was supplied without adding an API node', async () => {
    const fixture = await createFixture();

    const task = await fixture.inputs.saveApiDocuments('refund-123', undefined);

    expect(task.inputs.apiDocuments).toEqual({ status: 'absent' });
    expect(task.nodes).not.toHaveProperty('api-analysis');
    expect(task.nodes.solution?.dependsOn).toEqual(['requirement-analysis']);
  });

  it('adds only supplied material nodes and makes solution wait for design slicing', async () => {
    const fixture = await createFixture();
    const imagePath = join(fixture.root, '退款页.PNG');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await writeFile(imagePath, png);

    const afterApi = await fixture.inputs.saveApiDocuments('refund-123', ['https://api.example.test/refund', 'https://api.example.test/order']);
    const task = await fixture.inputs.saveDesignImage('refund-123', imagePath);

    expect(afterApi.inputs.apiDocuments).toEqual({ status: 'provided', urls: ['https://api.example.test/refund', 'https://api.example.test/order'] });
    expect(afterApi.nodes['api-analysis']).toMatchObject({ phase: 'api-analysis', status: 'ready', dependsOn: ['requirement-analysis'], skills: [{ name: 'api-analysis' }] });
    expect(task.nodes['design-slicing']).toMatchObject({ phase: 'design-slicing', status: 'pending', dependsOn: ['api-analysis'], skills: [{ name: 'design-slicing' }] });
    expect(task.nodes.solution?.dependsOn).toEqual(['design-slicing']);
    expect(task.inputs.design).toMatchObject({ status: 'provided', image: { id: 'design-image', imagePath: 'sources/design/design-image.png', mediaType: 'image/png' } });
    await expect(readFile(join(fixture.store.taskDirectory(task.id), 'sources/design/design-image.png'))).resolves.toEqual(png);
    await expect(fixture.inputs.saveDesignImage('refund-123', imagePath)).rejects.toThrow('不能重复提交');
  });

  it('requires completed requirement analysis before accepting optional materials', async () => {
    const fixture = await createFixture({ completeRequirement: false });

    await expect(fixture.inputs.saveApiDocuments('refund-123', undefined)).rejects.toThrow('请先完成需求分析');
  });
});

async function createFixture(options: { completeRequirement?: boolean } = {}) {
  const root = await createTempDirectory('aiw-inputs-'); directories.push(root);
  const store = new TaskStore(root);
  const task = createSevenPhaseTask();
  task.skillProfile = { name: profile().name, registrySource: profile().registrySource, sha256: profile().sha256 };
  task.nodes['requirement-analysis']!.status = options.completeRequirement === false ? 'ready' : 'completed';
  await store.create(task);
  const registry = new SkillRegistry(join(root, '.aiw', 'registry.yaml'));
  await registry.replace({ skills: skills(), profiles: [profile()] });
  return { root, store, inputs: new TaskInputService({ taskStore: store, registry }) };
}

function profile(): InstalledWorkflowProfile {
  return {
    name: 'standard-web-feature', description: 'profile', aiwCompatibility: '>=0.0.1 <1.0.0', artifactContract: 'aiw.task-output/v2',
    registrySource: { url: 'git@example.test/agent-skills.git', revision: 'a1b2c3d4' }, sha256: hash('profile'),
    skills: {
      'api-analysis': ['api-analysis@1.0.0'], 'design-slicing': ['design-slicing@1.0.0'], 'requirement-analysis': ['requirement-analysis@1.0.0'],
      solution: ['technical-solution@1.0.0'], plan: ['implementation-planning@1.0.0'], development: ['typescript-web-implementation@1.0.0'],
    },
  };
}

function skills(): InstalledSkill[] {
  return [['api-analysis', 'api-analysis'], ['design-slicing', 'design-slicing']].map(([name, phase]) => ({
    name, version: '1.0.0', description: name, aiwCompatibility: '>=0.0.1 <1.0.0' as const, artifactContract: 'aiw.task-output/v2' as const,
    phases: [phase as InstalledSkill['phases'][number]], body: '# skill', registrySource: { url: 'git@example.test/agent-skills.git', revision: 'a1b2c3d4' }, sha256: hash(name),
  }));
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
