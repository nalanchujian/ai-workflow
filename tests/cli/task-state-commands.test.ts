import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { TaskStateCommands } from '../../src/cli/task-state-commands.js';
import { TaskDecisionService } from '../../src/services/task-decision-service.js';
import { TaskFactGuard } from '../../src/services/task-fact-guard.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

describe('TaskStateCommands', () => {
  it('reviews clarification by resolving all decisions and unlocks solution', async () => {
    const fixture = await createFixture();
    const task = await fixture.store.load('refund-123');
    task.nodes.clarify!.status = 'awaiting_approval'; task.nodes.clarify!.hasResult = true;
    await fixture.store.update(task);
    await fixture.store.replaceFact(task.id, 'artifacts/clarify/decision-register.yaml', decisionRegister());

    const reviewed = await fixture.commands.reviewClarify(task.id, [{ index: 0, action: 'continue', option: 0 }], { note: '确认' });

    expect(reviewed.nodes.clarify?.status).toBe('completed');
    expect(reviewed.nodes.solution?.status).toBe('ready');
    expect(reviewed.approvalRefs).toContain('approvals/clarify.yaml');
  });

  it('approves a development plan and preserves dependencies between development units', async () => {
    const fixture = await createFixture();
    const task = await fixture.store.load('refund-123');
    task.nodes.clarify!.status = 'completed'; task.nodes.solution!.status = 'completed'; task.nodes.plan!.status = 'awaiting_approval'; task.nodes.plan!.hasResult = true;
    await fixture.store.update(task);
    await fixture.store.replaceFact(task.id, 'artifacts/plan/development-plan.yaml', stringify({
      schemaVersion: 'aiw.development-plan/v1',
      units: [
        { title: '退款入口', goal: '增加退款入口', requirements: ['展示入口'], codeScope: ['src/refund'], steps: ['实现入口'], dependencies: [] },
        { title: '退款表单', goal: '提交退款申请', requirements: ['填写原因'], codeScope: ['src/refund-form'], steps: ['实现表单'], dependencies: ['退款入口'] },
      ],
    }));

    const approved = await fixture.commands.approve(task.id, 'plan', { note: '通过' });

    expect(approved.nodes.plan?.status).toBe('completed');
    expect(approved.nodes['development-unit-1']).toMatchObject({ phase: 'development', status: 'ready' });
    expect(approved.nodes['development-unit-2']).toMatchObject({ phase: 'development', status: 'pending', dependsOn: ['development-unit-1'] });
    expect(approved.nodes).not.toHaveProperty('verify');
    expect(approved.nodes).not.toHaveProperty('test');
  });
});

async function createFixture() {
  const root = await createTempDirectory('aiw-state-'); directories.push(root);
  const store = new TaskStore(root); await store.create(createSevenPhaseTask());
  const taskFactGuard = new TaskFactGuard({ repositoryStatus: { async uncommittedPaths() { return []; }, async authorName() { return 'developer'; } } });
  return { store, commands: new TaskStateCommands({ taskStore: store, taskFactGuard, decisionService: new TaskDecisionService({ taskStore: store }) }) };
}

function decisionRegister(): string {
  return stringify({ schemaVersion: 'aiw.decision-register/v2', pendingDecisions: [{ question: '接口方案？', background: '有两个方案。', impact: '影响实现。', options: [{ title: '复用接口', tradeoffs: '改动小。' }], recommendation: { option: 0, rationale: '优先复用。' } }], currentDecisions: [], deferredItems: [] });
}
