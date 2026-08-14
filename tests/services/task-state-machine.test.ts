import { describe, expect, it } from 'vitest';

import { TaskTransitionError, invalidateDependents, reconcileDecisionBlocks, transitionNode } from '../../src/services/task-state-machine.js';
import { createSevenPhaseTask, createSkillLock } from '../helpers/task-fixtures.js';

describe('task state machine', () => {
  it('marks the task completed when every node is completed', () => {
    const task = createSevenPhaseTask();
    for (const node of Object.values(task.nodes)) {
      node.status = 'completed';
    }
    task.nodes.test.status = 'running';
    task.nodes.test.requiresApproval = false;

    const next = transitionNode(task, 'test', { type: 'succeed', runId: 'test-run-1', outputs: [], evidencePath: 'runs/test-run-1/change-evidence.json' });

    expect(next.status).toBe('completed');
  });

  it('marks the task blocked when no node can progress after a failure', () => {
    const task = createSevenPhaseTask();
    task.nodes.intake.status = 'completed';
    task.nodes.clarify.status = 'running';
    for (const node of Object.values(task.nodes)) {
      if (node !== task.nodes.intake && node !== task.nodes.clarify) {
        node.status = 'pending';
      }
    }

    const next = transitionNode(task, 'clarify', { type: 'fail', message: 'Codex unavailable' });

    expect(next.status).toBe('blocked');
  });
  it('makes a pending node ready only after every dependency completes', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';

    const next = transitionNode(task, 'solution', { type: 'evaluate' });

    expect(next.nodes.solution.status).toBe('ready');
  });

  it('leaves a pending node blocked when a dependency is not completed', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'awaiting_approval';

    const next = transitionNode(task, 'solution', { type: 'evaluate' });

    expect(next.nodes.solution.status).toBe('pending');
  });

  it('unlocks only the work unit whose blocking decision has been resolved', () => {
    const task = createSevenPhaseTask();
    task.nodes.plan.status = 'completed';
    task.nodes.implement.status = 'blocked';
    task.nodes.implement.blockedByDecisionIds = ['DEC-API-01'];
    task.nodes.verify.status = 'pending';
    task.decisions = [{
      id: 'DEC-API-01', revision: 2, status: 'resolved', optionId: 'wait-api', actor: 'backend-lead',
      at: '2026-08-14T00:00:00.000Z', factPath: 'decisions/DEC-API-01/r2.yaml',
    }];

    const next = reconcileDecisionBlocks(task, 'DEC-API-01');

    expect(next.nodes.implement.status).toBe('ready');
    expect(next.nodes.verify.status).toBe('pending');
    expect(next.status).toBe('active');
  });

  it('invalidates every started descendant while retaining untouched pending descendants', () => {
    const task = createSevenPhaseTask();
    task.nodes.solution.status = 'completed';
    task.nodes.plan.status = 'awaiting_approval';
    task.nodes.implement.status = 'ready';
    task.nodes.verify.status = 'running';

    const next = invalidateDependents(task, 'clarify', 'requirements changed');

    expect(next.nodes.solution.status).toBe('invalidated');
    expect(next.nodes.plan.status).toBe('invalidated');
    expect(next.nodes.implement.status).toBe('invalidated');
    expect(next.nodes.verify.status).toBe('invalidated');
    expect(next.nodes.test.status).toBe('pending');
  });

  it('moves an approval-required node to awaiting approval after a successful run', () => {
    const task = createSevenPhaseTask();

    const running = transitionNode(task, 'clarify', { type: 'start', runId: 'run-01' });
    const next = transitionNode(running, 'clarify', {
      type: 'succeed', runId: 'clarify-run-1', evidencePath: 'runs/clarify-run-1/change-evidence.json',
      outputs: [{ path: 'artifacts/brief.md', sha256: 'd'.repeat(64) }],
    });

    expect(next.nodes.clarify.status).toBe('awaiting_approval');
    expect(next.nodes.clarify.revision).toBe(1);
  });

  it('approves a node and unlocks its direct dependent', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'awaiting_approval';

    const next = transitionNode(task, 'clarify', { type: 'approve', actor: 'tech-lead' });

    expect(next.nodes.clarify.status).toBe('completed');
    expect(next.nodes.solution.status).toBe('ready');
  });

  it('records requested changes and invalidates downstream work', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'completed';
    task.nodes.plan.status = 'awaiting_approval';
    task.nodes.implement.status = 'completed';

    const next = transitionNode(task, 'plan', {
      type: 'request_changes',
      actor: 'tech-lead',
      note: '补充回滚方案',
    });

    expect(next.nodes.plan.status).toBe('ready');
    expect(next.nodes.implement.status).toBe('invalidated');
    expect(next.events).toContainEqual(expect.objectContaining({ type: 'request_changes', nodeId: 'plan', note: '补充回滚方案' }));
  });

  it('requires an approval decision instead of directly revising an awaiting approval node', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'awaiting_approval';

    expect(() => transitionNode(task, 'clarify', { type: 'revise', actor: 'developer', note: '补充边界' }))
      .toThrow('等待审批');
  });

  it('re-evaluates a revised node when its dependencies are already completed', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'completed';

    const next = transitionNode(task, 'solution', { type: 'revise', actor: 'developer', note: '补充异常分支' });

    expect(next.nodes.solution.status).toBe('ready');
    expect(next.events.map((event) => event.type)).toContain('evaluate');
  });

  it('allows an explicit skill rebind only for a node that is not complete', () => {
    const task = createSevenPhaseTask();
    const previousSkill = task.nodes.clarify.skill;
    const replacementSkill = createSkillLock('requirements-clarification-v2');

    const next = transitionNode(task, 'clarify', {
      type: 'rebind_skill',
      skill: replacementSkill,
      note: '增加合规检查',
    });

    expect(next.nodes.clarify.skill?.name).toBe('requirements-clarification-v2');
    expect(next.events.at(-1)).toMatchObject({
      type: 'rebind_skill',
      nodeId: 'clarify',
      note: '增加合规检查',
      previousSkill,
      nextSkill: replacementSkill,
    });

    next.nodes.clarify.status = 'completed';
    expect(() => transitionNode(next, 'clarify', {
      type: 'rebind_skill',
      skill: createSkillLock('requirements-clarification-v3'),
      note: '不应替换已完成节点',
    })).toThrow(TaskTransitionError);
  });
});
