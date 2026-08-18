import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { TaskDecisionService } from '../../src/services/task-decision-service.js';
import { TaskStore } from '../../src/services/task-store.js';
import { completedArtifactPath } from '../../src/domain/handoff.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTempDirectory));
});

describe('TaskDecisionService', () => {
  it('records a selected AI option as an immutable decision fact', async () => {
    const { store, service } = await fixture();

    const task = await service.choose({ taskId: 'refund-123', decisionId: 'DEC-API-01', optionId: 'wait-api', actor: 'tech-lead', status: 'waiting_external', owner: 'backend', unblockCondition: '接口契约与联调样例已确认' });

    expect(task.decisions).toEqual([expect.objectContaining({ id: 'DEC-API-01', revision: 1, optionId: 'wait-api', status: 'waiting_external', owner: 'backend' })]);
    await expect(readFile(join(store.taskDirectory(task.id), 'decisions', 'DEC-API-01', 'r1.yaml'), 'utf8'))
      .resolves.toContain('status: waiting_external');
  });

  it('only resolves an existing external wait and keeps a revision history', async () => {
    const { store, service } = await fixture();
    await service.choose({ taskId: 'refund-123', decisionId: 'DEC-API-01', optionId: 'wait-api', actor: 'tech-lead', status: 'waiting_external', owner: 'backend', unblockCondition: '接口契约与联调样例已确认' });

    const task = await service.resolve({ taskId: 'refund-123', decisionId: 'DEC-API-01', actor: 'backend-lead', note: '接口已发布并提供样例。' });

    expect(task.decisions).toEqual([expect.objectContaining({ id: 'DEC-API-01', revision: 2, status: 'resolved', optionId: 'wait-api' })]);
    await expect(readFile(join(store.taskDirectory(task.id), 'decisions', 'DEC-API-01', 'r2.yaml'), 'utf8'))
      .resolves.toContain('status: resolved');
  });

  it('supersedes only the blocked work unit when a decision is explicitly deferred', async () => {
    const { store, service } = await fixture();
    await service.choose({ taskId: 'refund-123', decisionId: 'DEC-API-01', optionId: 'wait-api', actor: 'tech-lead', status: 'waiting_external', owner: 'backend', unblockCondition: '接口契约与联调样例已确认' });
    const waiting = await store.load('refund-123');
    waiting.nodes.implement = {
      ...waiting.nodes.implement,
      status: 'blocked',
      blockedByDecisionIds: ['DEC-API-01'],
    };
    waiting.nodes.verify.dependsOn = ['implement'];
    await store.update(waiting);

    const task = await service.choose({ taskId: 'refund-123', decisionId: 'DEC-API-01', optionId: 'defer-scope', actor: 'product-owner', status: 'deferred', note: '接口能力拆至下个版本。' });

    expect(task.nodes.implement.status).toBe('superseded');
    expect(task.nodes.verify.dependsOn).toEqual([]);
  });

  it('derives the decision status from the selected option instead of accepting a conflicting status', async () => {
    const { service } = await fixture();

    await expect(service.choose({
      taskId: 'refund-123', decisionId: 'DEC-API-01', optionId: 'defer-scope', actor: 'product-owner',
      status: 'resolved', note: '接口能力拆至下个版本。',
    })).rejects.toThrow('决策选项的处理结果必须为：deferred');
  });
});

async function fixture(): Promise<{ store: TaskStore; service: TaskDecisionService }> {
  const directory = await createTempDirectory('aiw-decision-');
  directories.push(directory);
  const store = new TaskStore(directory);
  const task = createSevenPhaseTask();
  task.nodes.clarify!.revision = 1;
  await store.create(task);
  const registerPath = completedArtifactPath('clarify', task.nodes.clarify!, 'artifacts/decision-register.yaml');
  await mkdir(join(store.taskDirectory(task.id), registerPath, '..'), { recursive: true });
  await writeFile(join(store.taskDirectory(task.id), registerPath), `schemaVersion: aiw.decision-register/v1\nitems:\n  - id: DEC-API-01\n    title: 详情趋势数据来源\n    detail:\n      question: 详情趋势与导出本期使用哪一套服务端接口？\n      background: 当前需求与仓库未提供趋势、导出和日期聚合的统一契约。\n      impact: 不确认会使页面、导出与验收采用不同的数据口径。\n    type: external-contract\n    affects:\n      acceptanceRefs: [AC-07]\n      workUnits: [performance-overview]\n    status: proposed\n    options:\n      - id: wait-api\n        title: 等待正式 API\n        tradeoffs: 交付依赖后端排期，但数据口径一致。\n        effect: waiting_external\n      - id: defer-scope\n        title: 拆至后续版本\n        tradeoffs: 当前范围缩小，需要后续跟踪。\n        effect: deferred\n    recommendation:\n      optionId: wait-api\n      rationale: 当前仓库没有可信详情与趋势接口。\n`, 'utf8');
  return { store, service: new TaskDecisionService({ taskStore: store }) };
}
