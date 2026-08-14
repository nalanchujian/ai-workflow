import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ContextBuilder } from '../../src/services/context-builder.js';
import { handoffPath } from '../../src/domain/handoff.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

describe('ContextBuilder', () => {
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('builds a plan manifest with only declared facts and the locked method source', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    await writeHandoff(directory, task, 'solution');
    task.nodes.plan.skill!.methodSources = [{ id: 'superpowers:writing-plans', source: 'bundled:superpowers', version: '6.2.0', revision: 'd'.repeat(40), sha256: 'd'.repeat(64) }];
    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory }).build({ task, nodeId: 'plan', includes: [] });

    expect(manifest.files.map((file) => file.path)).toEqual([
      handoffPath('solution', 0),
    ]);
    expect(manifest.skill.methodSources).toContainEqual(expect.objectContaining({ id: 'superpowers:writing-plans', revision: 'd'.repeat(40) }));
  });

  it('uses completed upstream handoffs instead of Markdown artifacts from solution through test', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    task.nodes['implement-details'] = {
      ...task.nodes.implement,
      title: '实现详情页',
      outputs: ['artifacts/subtasks/implement-details.md'],
    };
    task.nodes.verify.dependsOn = ['implement', 'implement-details'];
    await mkdir(join(directory, 'artifacts', 'subtasks'), { recursive: true });
    await writeFile(join(directory, 'artifacts', 'subtasks', 'implement-details.md'), '# 详情页实施记录\n', 'utf8');
    for (const nodeId of ['clarify', 'solution', 'plan', 'implement', 'implement-details', 'verify']) {
      await writeHandoff(directory, task, nodeId);
    }

    const builder = new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory });

    await expect(builder.build({ task, nodeId: 'solution', includes: [] })).resolves.toMatchObject({
      files: [{ role: 'handoff', path: handoffPath('clarify', 0) }],
    });
    await expect(builder.build({ task, nodeId: 'plan', includes: [] })).resolves.toMatchObject({
      files: [{ role: 'handoff', path: handoffPath('solution', 0) }],
    });
    await expect(builder.build({ task, nodeId: 'implement', includes: [] })).resolves.toMatchObject({
      files: [{ role: 'handoff', path: handoffPath('plan', 0) }],
    });
    await expect(builder.build({ task, nodeId: 'verify', includes: [] })).resolves.toMatchObject({
      files: [
        { role: 'handoff', path: handoffPath('implement', 0) },
        { role: 'handoff', path: handoffPath('implement-details', 0) },
      ],
    });
    await expect(builder.build({ task, nodeId: 'test', includes: [] })).resolves.toMatchObject({
      files: [{ role: 'handoff', path: handoffPath('verify', 0) }],
    });
  });

  it('injects only the approved plan handoff for implementation', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    await writeHandoff(directory, task, 'plan');

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'implement', includes: [] });

    expect(manifest.files.map((file) => file.path)).toEqual([
      handoffPath('plan', 0),
    ]);
  });

  it('uses the plan handoff instead of the current implementation work unit Markdown', async () => {
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
    await writeHandoff(directory, task, 'plan');

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'implement-export', includes: [] });

    expect(manifest.files.map((file) => file.path)).toEqual([
      handoffPath('plan', 0),
    ]);
  });

  it('builds verification context from every implementation handoff', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    task.nodes['implement-details'] = {
      ...task.nodes.implement,
      title: '实现详情页',
      outputs: ['artifacts/subtasks/implement-details.md'],
    };
    await mkdir(join(directory, 'artifacts', 'subtasks'), { recursive: true });
    await writeFile(join(directory, 'artifacts', 'subtasks', 'implement-details.md'), '# 详情页实施记录\n', 'utf8');
    task.nodes.verify.dependsOn = ['implement', 'implement-details'];
    await writeHandoff(directory, task, 'implement');
    await writeHandoff(directory, task, 'implement-details');

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'verify', includes: [] });

    expect(manifest.files.map((file) => file.path)).toEqual([
      handoffPath('implement', 0),
      handoffPath('implement-details', 0),
    ]);
  });

  it('builds test context from the verification handoff', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    task.nodes['implement-details'] = {
      ...task.nodes.implement,
      title: '实现详情页',
      outputs: ['artifacts/subtasks/implement-details.md'],
    };
    await mkdir(join(directory, 'artifacts', 'subtasks'), { recursive: true });
    await writeFile(join(directory, 'artifacts', 'subtasks', 'implement-details.md'), '# 详情页实施记录\n', 'utf8');
    await writeHandoff(directory, task, 'verify');

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'test', includes: [] });

    expect(manifest.files.map((file) => file.path)).toEqual([
      handoffPath('verify', 0),
    ]);
  });

  it('fails above the context budget without changing the approved artifact', async () => {
    const directory = await taskDirectory();
    const artifactPath = join(directory, 'artifacts', 'implementation-plan.md');
    const original = 'x'.repeat(128);
    await writeFile(artifactPath, original, 'utf8');
    const task = createSevenPhaseTask();
    await writeHandoff(directory, task, 'plan');

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
    await writeHandoff(directory, task, 'solution');
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

async function writeHandoff(directory: string, task: ReturnType<typeof createSevenPhaseTask>, nodeId: string): Promise<void> {
  const node = task.nodes[nodeId];
  if (node === undefined) throw new Error(`未知节点：${nodeId}`);
  const path = handoffPath(nodeId, node.revision);
  await mkdir(join(directory, 'handoffs', nodeId), { recursive: true });
  await writeFile(join(directory, path), `schemaVersion: aiw.handoff/v1\ntaskId: ${task.id}\nnodeId: ${nodeId}\nphase: ${node.phase}\nrevision: ${node.revision}\nsummary: 已完成${node.title}并提供结构化交接内容。\nfacts:\n  - id: FACT-01\n    statement: 当前节点已形成可供下游使用的结论。\n    evidence:\n      - path: ${node.outputs[0]}\ndecisions: []\nacceptance: []\nchanges: []\nverification: []\nopenRisks: []\n`, 'utf8');
}
