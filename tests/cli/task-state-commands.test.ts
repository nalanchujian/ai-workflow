import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { createTaskStateCommand, TaskStateCommands } from '../../src/cli/task-state-commands.js';
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
        { name: 'development-unit-refund-entry', title: '退款入口', goal: '增加退款入口', requirements: ['展示入口'], codeScope: ['src/refund'], steps: ['实现入口'], dependencies: [] },
        { name: 'development-unit-refund-form', title: '退款表单', goal: '提交退款申请', requirements: ['填写原因'], codeScope: ['src/refund-form'], steps: ['实现表单'], dependencies: ['development-unit-refund-entry'] },
      ],
    }));

    const approved = await fixture.commands.approve(task.id, 'plan', { note: '通过' });

    expect(approved.status).toBe('active');
    expect(approved.nodes.plan?.status).toBe('completed');
    expect(approved.nodes['development-unit-refund-entry']).toMatchObject({ phase: 'development', status: 'ready' });
    expect(approved.nodes['development-unit-refund-form']).toMatchObject({ phase: 'development', status: 'pending', dependsOn: ['development-unit-refund-entry'] });
    expect(approved.nodes).not.toHaveProperty('verify');
    expect(approved.nodes).not.toHaveProperty('test');
  });

  it('ignores a failed leaf development unit and records the operator reason', async () => {
    const fixture = await createFixture();
    const task = await fixture.store.load('refund-123');
    task.nodes.clarify!.status = 'completed'; task.nodes.solution!.status = 'completed'; task.nodes.plan!.status = 'completed';
    task.nodes['development-unit-external-page'] = {
      title: '外部应用开发', phase: 'development', dependsOn: ['plan'], skill: task.developmentSkill,
      requiresApproval: false, status: 'failed', hasResult: false,
      outputs: ['artifacts/development/development-unit-external-page/result.md'], generatedFromPlan: true,
      contextPath: 'artifacts/plan/units/development-unit-external-page.yaml',
    };
    await fixture.store.update(task);

    const ignored = await fixture.commands.ignore(task.id, 'development-unit-external-page', { note: '不属于当前仓库' });

    expect(ignored.status).toBe('completed');
    expect(ignored.nodes['development-unit-external-page']?.status).toBe('ignored');
    expect(ignored.events.at(-1)).toMatchObject({ type: 'ignore', note: '不属于当前仓库', actor: 'developer' });
  });
});

describe('task state command guidance', () => {
  it('instructs the user to commit review facts before running solution', async () => {
    let output = '';
    const reviewed = taskWithReadyNode('solution');
    reviewed.nodes.clarify!.status = 'completed';
    const command = createTaskStateCommand({
      commands: {
        async status() { return taskAwaitingClarifyReview(); },
        async pendingDecisions() { return []; },
        async reviewClarify() { return reviewed; },
        async uncommittedTaskPaths() { return ['.aiw/tasks/refund-123/task.yaml']; },
      } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['review', 'refund-123'], { from: 'user' });

    const commitIndex = output.indexOf('git add .aiw && git commit');
    const runIndex = output.indexOf('aiw task run refund-123 solution');
    expect(commitIndex).toBeGreaterThan(-1);
    expect(runIndex).toBeGreaterThan(commitIndex);
  });

  it('omits the commit instruction after approval when task facts are already committed', async () => {
    let output = '';
    const command = createTaskStateCommand({
      commands: {
        async approve() { return taskWithReadyNode('development-unit-refund-entry'); },
        async uncommittedTaskPaths() { return []; },
      } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['approve', 'refund-123', 'plan', '--note', '通过'], { from: 'user' });

    expect(output).not.toContain('git add .aiw && git commit');
    expect(output).toContain('aiw task run refund-123 development-unit-refund-entry');
    expect(output).not.toContain('aiw task continue');
  });

  it('instructs the user to commit plan approval before running a development unit', async () => {
    let output = '';
    const command = createTaskStateCommand({
      commands: {
        async approve() { return taskWithReadyNode('development-unit-refund-entry'); },
        async uncommittedTaskPaths() { return ['.aiw/tasks/refund-123/approvals/plan.yaml']; },
      } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['approve', 'refund-123', 'plan', '--note', '通过'], { from: 'user' });

    const commitIndex = output.indexOf('git add .aiw && git commit');
    const runIndex = output.indexOf('aiw task run refund-123 development-unit-refund-entry');
    expect(commitIndex).toBeGreaterThan(-1);
    expect(runIndex).toBeGreaterThan(commitIndex);
  });

  it('shows the exact failed node command when a retry is available', async () => {
    let output = '';
    const failed = taskWithReadyNode('solution');
    failed.nodes.solution!.status = 'failed';
    const command = createTaskStateCommand({
      commands: {
        async status() { return failed; },
        async uncommittedTaskPaths() { return []; },
      } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['status', 'refund-123'], { from: 'user' });

    expect(output).toContain('aiw task run refund-123 solution');
    expect(output).not.toContain('aiw task continue');
  });

  it('shows ignored development progress and only asks the user to commit the task fact', async () => {
    let output = '';
    const ignored = taskWithReadyNode('development-unit-external-page');
    ignored.nodes['development-unit-external-page']!.status = 'ignored';
    ignored.status = 'completed';
    const command = createTaskStateCommand({
      commands: {
        async ignore() { return ignored; },
        async uncommittedTaskPaths() { return ['.aiw/tasks/refund-123/task.yaml']; },
      } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['ignore', 'refund-123', 'development-unit-external-page', '--note', '不属于当前仓库'], { from: 'user' });

    expect(output).toContain('「development-unit-external-page」开发单元已忽略');
    expect(output).toContain('已忽略 1');
    expect(output).toContain('git add .aiw && git commit');
    expect(output).not.toContain('aiw task run refund-123 development-unit-external-page');
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

function taskAwaitingClarifyReview() {
  const task = createSevenPhaseTask();
  task.nodes.clarify!.status = 'awaiting_approval';
  task.nodes.clarify!.hasResult = true;
  return task;
}

function taskWithReadyNode(nodeId: string) {
  const task = createSevenPhaseTask();
  for (const node of Object.values(task.nodes)) node.status = 'completed';
  task.nodes[nodeId] = {
    title: nodeId,
    phase: nodeId === 'solution' ? 'solution' : 'development',
    dependsOn: [],
    requiresApproval: false,
    status: 'ready',
    hasResult: false,
    outputs: [],
  };
  return task;
}
