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
  it('records a selected AI option as the current decision fact', async () => {
    const { store, service } = await fixture();

    const task = await service.choose({ taskId: 'refund-123', decisionId: 'DEC-API-01', optionId: 'wait-api', actor: 'tech-lead', status: 'waiting_external', owner: 'backend', unblockCondition: '接口契约与联调样例已确认' });

    expect(task.decisions).toEqual([expect.objectContaining({ id: 'DEC-API-01', optionId: 'wait-api', status: 'waiting_external', owner: 'backend' })]);
    await expect(readFile(join(store.taskDirectory(task.id), 'decisions', 'DEC-API-01.yaml'), 'utf8'))
      .resolves.toContain('status: waiting_external');
  });

  it('directly unlocks an external wait only when the plan remains valid', async () => {
    const { store, service } = await fixture();
    await service.choose({ taskId: 'refund-123', decisionId: 'DEC-API-01', optionId: 'wait-api', actor: 'tech-lead', status: 'waiting_external', owner: 'backend', unblockCondition: '接口契约与联调样例已确认' });

    const task = await service.resolve({ taskId: 'refund-123', decisionId: 'DEC-API-01', actor: 'backend-lead', impact: 'execution-only', note: '测试环境已经恢复，原计划和验收方式不变。' });

    expect(task.decisions).toEqual([expect.objectContaining({ id: 'DEC-API-01', status: 'resolved', optionId: 'wait-api', resolutionImpact: 'execution-only' })]);
    await expect(readFile(join(store.taskDirectory(task.id), 'decisions', 'DEC-API-01.yaml'), 'utf8'))
      .resolves.toContain('status: resolved');
  });

  it('records new external facts and invalidates solution and plan when they must be replanned', async () => {
    const { store, service } = await fixture();
    await service.choose({ taskId: 'refund-123', decisionId: 'DEC-API-01', optionId: 'wait-api', actor: 'tech-lead', status: 'waiting_external', owner: 'backend', unblockCondition: '接口契约与联调样例已确认' });
    const waiting = await store.load('refund-123');
    waiting.nodes.clarify!.status = 'completed';
    waiting.nodes.solution!.status = 'completed';
    waiting.nodes.plan!.status = 'completed';
    waiting.nodes.implement!.status = 'blocked';
    waiting.nodes.implement!.blockedByDecisionIds = ['DEC-API-01'];
    waiting.nodes.implement!.decisionRefs = ['DEC-API-01'];
    waiting.approvalRefs = ['approvals/clarify.yaml', 'approvals/plan.yaml'];
    await store.update(waiting);

    const task = await service.resolve({
      taskId: 'refund-123',
      decisionId: 'DEC-API-01',
      actor: 'backend-lead',
      impact: 'replan',
      fact: '正式接口已定义 columnKeys、字段顺序、空值语义和两 Sheet 导出响应。',
      evidence: 'https://example.test/contracts/link-export-v2',
      note: '后端已交付正式接口契约。',
    });

    expect(task.decisions).toEqual([expect.objectContaining({
      id: 'DEC-API-01',
      status: 'resolved',
      resolutionImpact: 'replan',
      inputFactPath: 'external-inputs/DEC-API-01.yaml',
    })]);
    expect(task.nodes.solution?.status).toBe('invalidated');
    expect(task.nodes.plan?.status).toBe('invalidated');
    expect(task.nodes.implement?.status).toBe('invalidated');
    expect(task.approvalRefs).toEqual(['approvals/clarify.yaml']);
    await expect(readFile(join(store.taskDirectory(task.id), 'external-inputs', 'DEC-API-01.yaml'), 'utf8'))
      .resolves.toContain('正式接口已定义 columnKeys');
  });

  it('requires a structured fact when an external wait changes the plan', async () => {
    const { service } = await fixture();
    await service.choose({ taskId: 'refund-123', decisionId: 'DEC-API-01', optionId: 'wait-api', actor: 'tech-lead', status: 'waiting_external', owner: 'backend', unblockCondition: '接口契约与联调样例已确认' });

    await expect(service.resolve({
      taskId: 'refund-123', decisionId: 'DEC-API-01', actor: 'backend-lead', impact: 'replan', note: '接口已经准备完成。',
    })).rejects.toThrow('重新规划必须提供新增事实');
  });

  it('does not let a proposal option encode workflow state', async () => {
    const { service } = await fixture();
    const task = await service.choose({
      taskId: 'refund-123', decisionId: 'DEC-API-01', optionId: 'wait-api', actor: 'tech-lead',
      status: 'resolved', note: '采用正式接口契约。',
    });

    expect(task.decisions).toEqual([expect.objectContaining({ status: 'resolved', optionId: 'wait-api' })]);
  });
});

async function fixture(): Promise<{ store: TaskStore; service: TaskDecisionService }> {
  const directory = await createTempDirectory('aiw-decision-');
  directories.push(directory);
  const store = new TaskStore(directory);
  const task = createSevenPhaseTask();
  task.nodes.clarify!.hasResult = true;
  await store.create(task);
  const registerPath = completedArtifactPath('clarify', task.nodes.clarify!, 'artifacts/decision-register.yaml');
  await mkdir(join(store.taskDirectory(task.id), registerPath, '..'), { recursive: true });
  await writeFile(join(store.taskDirectory(task.id), registerPath), [
    'schemaVersion: aiw.decision-register/v1',
    'items:',
    '  - id: DEC-API-01',
    '    title: 详情趋势数据来源',
    '    detail:',
    '      question: 详情趋势与导出本期使用哪一套服务端接口？',
    '      background: 当前需求与仓库未提供趋势、导出和日期聚合的统一契约。',
    '      impact: 不确认会使页面、导出与验收采用不同的数据口径。',
    '    type: external-contract',
    '    factRefs: [FACT-API-01]',
    '    affects:',
    '      acceptanceRefs: [AC-07]',
    '      workUnits: [performance-overview]',
    '    options:',
    '      - id: wait-api',
    '        title: 等待正式 API',
    '        tradeoffs: 交付依赖后端排期，但数据口径一致。',
    '    recommendation:',
    '      optionId: wait-api',
    '      rationale: 当前仓库没有可信详情与趋势接口。',
  ].join('\n') + '\n', 'utf8');
  return { store, service: new TaskDecisionService({ taskStore: store }) };
}
