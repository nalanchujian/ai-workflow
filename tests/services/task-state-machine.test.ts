import { describe, expect, it } from 'vitest';

import { TaskTransitionError, invalidateDependents, transitionNode } from '../../src/services/task-state-machine.js';
import { createSevenPhaseTask, createSkillLock } from '../helpers/task-fixtures.js';

describe('task state machine', () => {
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
      type: 'succeed',
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
    task.nodes.plan.status = 'awaiting_approval';
    task.nodes.implement.status = 'completed';

    const next = transitionNode(task, 'plan', {
      type: 'request_changes',
      actor: 'tech-lead',
      note: '补充回滚方案',
    });

    expect(next.nodes.plan.status).toBe('pending');
    expect(next.nodes.implement.status).toBe('invalidated');
    expect(next.events.at(-1)).toMatchObject({ type: 'request_changes', nodeId: 'plan', note: '补充回滚方案' });
  });

  it('allows an explicit skill rebind only for a node that is not complete', () => {
    const task = createSevenPhaseTask();

    const next = transitionNode(task, 'clarify', {
      type: 'rebind_skill',
      skill: createSkillLock('requirements-clarification-v2'),
      note: '增加合规检查',
    });

    expect(next.nodes.clarify.skill?.name).toBe('requirements-clarification-v2');
    expect(next.events.at(-1)).toMatchObject({ type: 'rebind_skill', nodeId: 'clarify', note: '增加合规检查' });

    next.nodes.clarify.status = 'completed';
    expect(() => transitionNode(next, 'clarify', {
      type: 'rebind_skill',
      skill: createSkillLock('requirements-clarification-v3'),
      note: '不应替换已完成节点',
    })).toThrow(TaskTransitionError);
  });
});
