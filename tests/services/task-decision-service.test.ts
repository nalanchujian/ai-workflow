import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { TaskDecisionService } from '../../src/services/task-decision-service.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

describe('TaskDecisionService', () => {
  it('moves each pending item either into current scope or deferred work without IDs', async () => {
    const root = await createTempDirectory('aiw-decision-'); directories.push(root);
    const store = new TaskStore(root);
    await store.create(createSevenPhaseTask());
    await store.replaceFact('refund-123', 'artifacts/clarify/decision-register.yaml', stringify({
      schemaVersion: 'aiw.decision-register/v2',
      pendingDecisions: [
        { question: '接口采用哪种方式？', background: '正式接口未提供。', impact: '影响数据接入。', options: [{ title: '使用现有接口', tradeoffs: '改动较小。' }, { title: '新增接口', tradeoffs: '能力完整。' }], recommendation: { option: 0, rationale: '优先复用。' } },
        { question: '邮件导出是否本期完成？', background: '邮件服务未接入。', impact: '影响邮件功能。', options: [{ title: '本期接入', tradeoffs: '需要外部依赖。' }], recommendation: { option: 0, rationale: '满足完整需求。' } },
      ], currentDecisions: [], deferredItems: [],
    }));
    const service = new TaskDecisionService({ taskStore: store });

    const result = await service.apply('refund-123', [
      { index: 0, action: 'continue', option: 0 },
      { index: 1, action: 'defer', reason: '等待邮件服务', suggestedNextStep: '单独创建邮件交付任务' },
    ]);

    expect(result.pendingDecisions).toEqual([]);
    expect(result.currentDecisions).toEqual([expect.objectContaining({ question: '接口采用哪种方式？', selectedApproach: '使用现有接口' })]);
    expect(result.deferredItems).toEqual([expect.objectContaining({ requirement: '邮件导出是否本期完成？', reason: '等待邮件服务' })]);
    expect(JSON.stringify(result)).not.toMatch(/DEC-|AC-|FACT-/);
  });
});
