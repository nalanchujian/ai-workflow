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
  it('resolves requirement decisions and unlocks API analysis without creating an approval record', async () => {
    const fixture = await createFixture();
    const task = await fixture.store.load('refund-123');
    task.nodes['requirement-analysis']!.status = 'awaiting_approval'; task.nodes['requirement-analysis']!.hasResult = true;
    await fixture.store.update(task);
    await fixture.store.replaceFact(task.id, 'artifacts/requirement-analysis/decision-register.yaml', decisionRegister());

    const reviewed = await fixture.commands.reviewRequirement(task.id, [{ index: 0, action: 'continue', option: 0 }], { note: '确认' });

    expect(reviewed.nodes['requirement-analysis']?.status).toBe('completed');
    expect(reviewed.nodes['api-analysis']?.status).toBe('ready');
    expect(reviewed.approvalRefs).toEqual([]);
  });

  it('ignores a failed leaf development unit and records the operator reason', async () => {
    const fixture = await createFixture();
    const task = await fixture.store.load('refund-123');
    task.nodes['requirement-analysis']!.status = 'completed'; task.nodes['api-analysis']!.status = 'completed'; task.nodes['design-slicing']!.status = 'completed'; task.nodes.solution!.status = 'completed'; task.nodes.plan!.status = 'completed';
    task.nodes['development-unit-external-page'] = {
      title: '外部应用开发', phase: 'development', dependsOn: ['plan'], skills: task.developmentSkills,
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
    reviewed.nodes['requirement-analysis']!.status = 'completed';
    const command = createTaskStateCommand({
      commands: {
        async status() { return taskAwaitingRequirementReview(); },
        async pendingDecisions() { return []; },
        async reviewRequirement() { return reviewed; },
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

function taskAwaitingRequirementReview() {
  const task = createSevenPhaseTask();
  task.nodes['requirement-analysis']!.status = 'awaiting_approval';
  task.nodes['requirement-analysis']!.hasResult = true;
  return task;
}

function taskWithReadyNode(nodeId: string) {
  const task = createSevenPhaseTask();
  task.inputs.apiDocuments = { status: 'absent' };
  task.inputs.design = { status: 'absent' };
  for (const node of Object.values(task.nodes)) node.status = 'completed';
  task.nodes[nodeId] = {
    title: nodeId,
    phase: nodeId === 'solution' ? 'solution' : 'development',
    dependsOn: [],
    skills: task.developmentSkills,
    requiresApproval: false,
    status: 'ready',
    hasResult: false,
    outputs: [],
  };
  return task;
}
