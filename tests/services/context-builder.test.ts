import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ContextBuilder } from '../../src/services/context-builder.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

describe('ContextBuilder', () => {
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('builds a plan manifest with only declared facts and the locked method source', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    task.nodes.plan.skill!.methodSources = [{ id: 'superpowers:writing-plans', source: 'bundled:superpowers', version: '6.2.0', revision: 'd'.repeat(40), sha256: 'd'.repeat(64) }];
    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory }).build({ task, nodeId: 'plan', includes: [] });

    expect(manifest.files.map((file) => file.path)).toEqual([
      'artifacts/brief.md',
      'artifacts/questions.md',
      'artifacts/acceptance.md',
      'artifacts/solution.md',
    ]);
    expect(manifest.skill.methodSources).toContainEqual(expect.objectContaining({ id: 'superpowers:writing-plans', revision: 'd'.repeat(40) }));
  });

  it('injects only the approved implementation context and acceptance criteria for implementation', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'implement', includes: [] });

    expect(manifest.files.map((file) => file.path)).toEqual([
      'artifacts/acceptance.md',
      'artifacts/implementation-context.md',
    ]);
  });

  it('uses the current implementation work unit context instead of the main unit context', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    task.nodes['implement-export'] = {
      ...task.nodes.implement,
      title: '实现导出',
      contextPath: 'artifacts/work-units/r1/implement-export.md',
      outputs: ['artifacts/subtasks/implement-export.md'],
    };
    await mkdir(join(directory, 'artifacts', 'work-units', 'r1'), { recursive: true });
    await writeFile(join(directory, 'artifacts', 'work-units', 'r1', 'implement-export.md'), '# 导出实施上下文\n', 'utf8');

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'implement-export', includes: [] });

    expect(manifest.files.map((file) => file.path)).toEqual([
      'artifacts/acceptance.md',
      'artifacts/work-units/r1/implement-export.md',
    ]);
  });

  it('builds verification context from acceptance criteria and every implementation record', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    task.nodes['implement-details'] = {
      ...task.nodes.implement,
      title: '实现详情页',
      outputs: ['artifacts/subtasks/implement-details.md'],
    };
    await mkdir(join(directory, 'artifacts', 'subtasks'), { recursive: true });
    await writeFile(join(directory, 'artifacts', 'subtasks', 'implement-details.md'), '# 详情页实施记录\n', 'utf8');

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'verify', includes: [] });

    expect(manifest.files.map((file) => file.path)).toEqual([
      'artifacts/acceptance.md',
      'artifacts/implementation.md',
      'artifacts/subtasks/implement-details.md',
    ]);
  });

  it('fails above the context budget without changing the approved artifact', async () => {
    const directory = await taskDirectory();
    const artifactPath = join(directory, 'artifacts', 'implementation-plan.md');
    const original = 'x'.repeat(128);
    await writeFile(artifactPath, original, 'utf8');
    const task = createSevenPhaseTask();

    await expect(new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory, maxTokens: 1 })
      .build({ task, nodeId: 'implement', includes: [] }))
      .rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' });
    await expect(readFile(artifactPath, 'utf8')).resolves.toBe(original);
  });

  it('includes runtime instruction blocks in the context budget', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();

    await expect(new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory, maxTokens: 10 })
      .build({
        task,
        nodeId: 'clarify',
        includes: [],
        budgetInputs: [{ label: '节点指令', content: 'x'.repeat(100) }],
      }))
      .rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED', paths: expect.arrayContaining(['节点指令']) });
  });

  it('includes the next revision instruction only for the node being rerun', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    task.nodes.plan.revision = 1;
    await mkdir(join(directory, 'revisions', 'plan'), { recursive: true });
    await writeFile(join(directory, 'revisions', 'plan', 'r2.md'), '补充回滚方案\n', 'utf8');

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'plan', includes: [] });

    expect(manifest.files).toContainEqual(expect.objectContaining({ role: 'revision-request', path: 'revisions/plan/r2.md' }));
  });

  it('rejects an additional file outside the project root', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();

    await expect(new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'clarify', includes: ['../secret.md'] }))
      .rejects.toMatchObject({ code: 'CONTEXT_INVALID' });
  });

  it('records the exact Lark snapshot revision in the clarify manifest', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    await mkdir(join(directory, 'sources', 'requirements', 'r2'), { recursive: true });
    await writeFile(join(directory, 'sources', 'requirements', 'r2', 'snapshot.md'), '# Lark requirements\n', 'utf8');
    task.sources.requirements = {
      kind: 'lark-document',
      origin: 'https://example.larksuite.com/docx/doccn123',
      externalId: 'doccn123',
      revision: 2,
      snapshotPath: 'sources/requirements/r2/snapshot.md',
      metaPath: 'sources/requirements/r2/meta.json',
      contentSha256: 'a'.repeat(64),
    };

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'clarify', includes: [] });

    expect(manifest.files).toContainEqual(expect.objectContaining({
      role: 'source',
      path: 'sources/requirements/r2/snapshot.md',
      sourceId: 'requirements',
      sourceRevision: 2,
    }));
  });
});

async function taskDirectory(): Promise<string> {
  const directory = await createTempDirectory('aiw-context-builder-');
  directories.push(directory);
  await mkdir(join(directory, 'artifacts'), { recursive: true });
  await writeFile(join(directory, 'task.md'), '# Refund\n', 'utf8');
  for (const name of ['brief.md', 'questions.md', 'acceptance.md', 'solution.md', 'implementation-plan.md', 'implementation-context.md', 'implementation.md', 'verification.md']) {
    await writeFile(join(directory, 'artifacts', name), `# ${name}\n`, 'utf8');
  }
  return directory;
}
