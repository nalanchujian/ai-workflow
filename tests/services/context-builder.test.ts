import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ContextBuilder } from '../../src/services/context-builder.js';
import { completedArtifactPath, handoffPath } from '../../src/domain/handoff.js';
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
      handoffPath('solution'),
    ]);
    expect(manifest.skill.methodSources).toContainEqual(expect.objectContaining({ id: 'superpowers:writing-plans', revision: 'd'.repeat(40) }));
  });

  it('uses completed upstream handoffs instead of Markdown artifacts across delivery units', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    task.nodes['delivery-details'] = {
      ...task.nodes.implement,
      title: '交付详情页',
      outputs: ['artifacts/delivery.md', 'artifacts/acceptance-intent.yaml', 'artifacts/test-results.yaml', 'artifacts/acceptance-results.yaml'],
      contextPath: 'artifacts/work-units/delivery-details.md',
      generatedFromPlan: true,
      acceptanceRefs: ['AC-01'],
    };
    task.nodes['delivery-integration'] = {
      ...task.nodes['delivery-details'],
      title: '交付集成验收',
      dependsOn: ['delivery-details'],
      contextPath: 'artifacts/work-units/delivery-integration.md',
    };
    const detailsPath = completedArtifactPath('delivery-details', task.nodes['delivery-details']!, 'artifacts/delivery.md');
    await mkdir(join(directory, detailsPath, '..'), { recursive: true });
    await writeFile(join(directory, detailsPath), '# 详情页实施记录\n', 'utf8');
    await mkdir(join(directory, 'artifacts', 'work-units'), { recursive: true });
    await writeFile(join(directory, 'artifacts', 'work-units', 'delivery-details.md'), '# 交付单元上下文\n', 'utf8');
    await writeFile(join(directory, 'artifacts', 'work-units', 'delivery-integration.md'), '# 交付单元上下文\n', 'utf8');
    for (const nodeId of ['clarify', 'solution', 'plan', 'delivery-details']) {
      await writeHandoff(directory, task, nodeId);
    }

    const builder = new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory });

    expect((await builder.build({ task, nodeId: 'solution', includes: [] })).files)
      .toContainEqual(expect.objectContaining({ role: 'handoff', path: handoffPath('clarify') }));
    expect((await builder.build({ task, nodeId: 'plan', includes: [] })).files)
      .toContainEqual(expect.objectContaining({ role: 'handoff', path: handoffPath('solution') }));
    expect((await builder.build({ task, nodeId: 'delivery-details', includes: [] })).files)
      .toContainEqual(expect.objectContaining({ role: 'handoff', path: handoffPath('plan') }));
    const integrationManifest = await builder.build({ task, nodeId: 'delivery-integration', includes: [] });
    expect(integrationManifest.files).toContainEqual(expect.objectContaining({ role: 'handoff', path: handoffPath('delivery-details') }));
  });

  it('injects the approved plan handoff and its isolated delivery-unit context', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    task.nodes['delivery-main'] = {
      ...task.nodes.implement,
      title: '交付退款功能',
      contextPath: 'artifacts/work-units/delivery-main.md',
      generatedFromPlan: true,
      acceptanceRefs: ['AC-01'],
    };
    await writeHandoff(directory, task, 'plan');
    await mkdir(join(directory, 'artifacts', 'work-units'), { recursive: true });
    await writeFile(join(directory, 'artifacts', 'work-units', 'delivery-main.md'), '# 交付单元上下文\n', 'utf8');

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'delivery-main', includes: [] });

    expect(manifest.files.map((file) => file.path)).toEqual([
      handoffPath('plan'),
      'artifacts/work-units/delivery-main.md',
    ]);
  });

  it('keeps decision alternatives out of solution and plan after review', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    task.nodes.clarify!.hasResult = true;
    await writeHandoff(directory, task, 'solution');
    const registerPath = completedArtifactPath('clarify', task.nodes.clarify!, 'artifacts/decision-register.yaml');
    await mkdir(join(directory, registerPath, '..'), { recursive: true });
    await writeFile(join(directory, registerPath), 'schemaVersion: aiw.decision-register/v1\nitems: []\n', 'utf8');

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'plan', includes: [] });

    expect(manifest.files.some((file) => file.path === registerPath)).toBe(false);
    expect(manifest.files.some((file) => file.path === completedArtifactPath('solution', task.nodes.solution!, 'artifacts/solution.md'))).toBe(false);
  });

  it('passes registered decision facts to solution and plan as traceable context', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    task.decisions = [{
      id: 'DEC-API-01', status: 'resolved', optionId: 'use-api', actor: 'tester',
      at: '2026-08-17T00:00:00.000Z', factPath: 'decisions/DEC-API-01.yaml',
    }];
    await writeHandoff(directory, task, 'clarify');
    await mkdir(join(directory, 'decisions'), { recursive: true });
    await writeFile(join(directory, 'decisions', 'DEC-API-01.yaml'), 'schemaVersion: aiw.decision/v1\n', 'utf8');

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'solution', includes: [] });

    expect(manifest.files).toContainEqual(expect.objectContaining({ role: 'artifact', path: 'decisions/DEC-API-01.yaml' }));
  });

  it('passes plan-changing external decision facts to solution and plan', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    task.decisions = [{
      id: 'DEC-API-01', status: 'resolved', optionId: 'wait-api', actor: 'backend-lead',
      at: '2026-08-18T00:00:00.000Z', factPath: 'decisions/DEC-API-01.yaml',
      resolutionImpact: 'replan', inputFactPath: 'external-inputs/DEC-API-01.yaml',
    }];
    await writeHandoff(directory, task, 'clarify');
    await mkdir(join(directory, 'decisions'), { recursive: true });
    await mkdir(join(directory, 'external-inputs'), { recursive: true });
    await writeFile(join(directory, 'decisions', 'DEC-API-01.yaml'), 'schemaVersion: aiw.decision/v1\n', 'utf8');
    await writeFile(join(directory, 'external-inputs', 'DEC-API-01.yaml'), 'schemaVersion: aiw.external-decision-input/v1\nsummary: 正式接口已定义字段映射与导出响应。\n', 'utf8');

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'solution', includes: [] });

    expect(manifest.files).toContainEqual(expect.objectContaining({ role: 'artifact', path: 'external-inputs/DEC-API-01.yaml' }));
  });

  it('injects the plan handoff together with the current implementation work unit Markdown', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    task.nodes['implement-export'] = {
      ...task.nodes.implement,
      title: '实现导出',
      contextPath: 'artifacts/work-units/implement-export.md',
      outputs: ['artifacts/subtasks/implement-export.md'],
    };
    await mkdir(join(directory, 'artifacts', 'work-units'), { recursive: true });
    await writeFile(join(directory, 'artifacts', 'work-units', 'implement-export.md'), '# 导出实施上下文\n', 'utf8');
    await writeHandoff(directory, task, 'plan');

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'implement-export', includes: [] });

    expect(manifest.files.map((file) => file.path)).toEqual([
      handoffPath('plan'),
      'artifacts/work-units/implement-export.md',
    ]);
  });

  it('builds an integration delivery context from its declared delivery-unit handoffs', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    task.nodes['delivery-details'] = {
      ...task.nodes.implement,
      title: '实现详情页',
      outputs: ['artifacts/delivery.md', 'artifacts/acceptance-intent.yaml', 'artifacts/test-results.yaml', 'artifacts/acceptance-results.yaml'],
      generatedFromPlan: true,
      acceptanceRefs: ['AC-01'],
    };
    await mkdir(join(directory, 'artifacts', 'subtasks'), { recursive: true });
    await writeFile(join(directory, 'artifacts', 'subtasks', 'implement-details.md'), '# 详情页实施记录\n', 'utf8');
    task.nodes['delivery-integration'] = { ...task.nodes['delivery-details'], title: '集成交付', dependsOn: ['delivery-details'], acceptanceRefs: ['AC-01'] };
    await writeHandoff(directory, task, 'delivery-details');

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'delivery-integration', includes: [] });

    expect(manifest.files.map((file) => file.path)).toEqual([
      handoffPath('delivery-details'),
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

  it('records a classified budget breakdown so an oversized context can be diagnosed', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    await writeHandoff(directory, task, 'solution');
    task.nodes.plan.skill!.methodSources = [{ id: 'superpowers:writing-plans', source: 'bundled:superpowers', version: '6.2.0', revision: 'd'.repeat(40), sha256: 'd'.repeat(64) }];

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory }).build({
      task,
      nodeId: 'plan',
      includes: [],
      budgetInputs: [
        { category: 'node-instruction', label: '节点指令', content: '制定可执行实施计划' },
        { category: 'skill', label: '技能：implementation-planning@1.0.0', content: 'x'.repeat(80) },
        { category: 'method-source', label: '方法论：superpowers:writing-plans', content: 'x'.repeat(40) },
      ],
    });

    expect(manifest.budget.breakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'handoff', label: handoffPath('solution') }),
      expect.objectContaining({ category: 'node-instruction', label: '节点指令' }),
      expect.objectContaining({ category: 'skill' }),
      expect.objectContaining({ category: 'method-source' }),
    ]));
  });

  it('rejects an additional file outside the project root', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();

    await expect(new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'clarify', includes: ['../secret.md'] }))
      .rejects.toMatchObject({ code: 'CONTEXT_INVALID' });
  });

  it('marks explicit project includes as reference-only instead of task evidence', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    await writeFile(join(directory, 'relevant-code.ts'), 'export const source = true;\n', 'utf8');

    const manifest = await new ContextBuilder({ taskDirectory: () => directory, projectRoot: () => directory })
      .build({ task, nodeId: 'clarify', includes: ['relevant-code.ts'] });

    expect(manifest.files).toContainEqual(expect.objectContaining({
      role: 'additional',
      path: 'relevant-code.ts',
      evidenceEligible: false,
    }));
    expect(manifest.files.filter((file) => file.role !== 'additional').every((file) => file.evidenceEligible)).toBe(true);
  });

  it('records the exact Lark snapshot revision in the clarify manifest', async () => {
    const directory = await taskDirectory();
    const task = createSevenPhaseTask();
    await mkdir(join(directory, 'sources', 'requirements', 'r2'), { recursive: true });
    await writeFile(join(directory, 'sources', 'requirements', 'r2', 'snapshot.md'), '# Lark requirements\n', 'utf8');
    task.sources.requirements = {
      kind: 'connected-document',
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
  await writeFile(join(directory, 'task.yaml'), 'schemaVersion: aiw.task/v2\n', 'utf8');
  for (const name of ['brief.md', 'questions.md', 'acceptance.md', 'solution.md', 'implementation-plan.md', 'implementation-context.md', 'implementation.md', 'verification.md']) {
    await writeFile(join(directory, 'artifacts', name), `# ${name}\n`, 'utf8');
  }
  return directory;
}

async function writeHandoff(directory: string, task: ReturnType<typeof createSevenPhaseTask>, nodeId: string): Promise<void> {
  const node = task.nodes[nodeId];
  if (node === undefined) throw new Error(`未知节点：${nodeId}`);
  const firstOutput = completedArtifactPath(nodeId, node, node.outputs[0]!);
  await mkdir(join(directory, firstOutput, '..'), { recursive: true });
  await writeFile(join(directory, firstOutput), '# 节点产物\n', 'utf8');
  const path = handoffPath(nodeId);
  await mkdir(join(directory, 'handoffs'), { recursive: true });
  await writeFile(join(directory, path), `schemaVersion: aiw.handoff/v1\ntaskId: ${task.id}\nnodeId: ${nodeId}\nphase: ${node.phase}\nsummary: 已完成${node.title}并提供结构化交接内容。\nfacts:\n  - id: FACT-REFUND-01\n    statement: 当前节点已形成可供下游使用的结论。\n    evidence:\n      - path: ${firstOutput}\ndecisions: []\nacceptance: []\nchanges: []\nverification: []\nopenRisks: []\n`, 'utf8');
}
