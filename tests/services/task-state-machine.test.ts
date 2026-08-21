import { describe, expect, it } from 'vitest';

import { restartDependentsForSourceChange, transitionNode } from '../../src/services/task-state-machine.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';

describe('task state machine', () => {
  it('moves clarification to approval without artifact hashes', () => {
    const task = createSevenPhaseTask();
    const running = transitionNode(task, 'clarify', { type: 'start', runId: 'run-01' });
    const next = transitionNode(running, 'clarify', {
      type: 'succeed', runId: 'run-01', outputs: [{ path: 'artifacts/clarify/fact-register.yaml' }],
    });
    expect(next.nodes.clarify).toMatchObject({ status: 'awaiting_approval', hasResult: true });
  });

  it('approves clarification and unlocks solution', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify!.status = 'awaiting_approval';
    const next = transitionNode(task, 'clarify', { type: 'approve', actor: 'developer' });
    expect(next.nodes.solution!.status).toBe('ready');
  });

  it('reruns an upstream node and invalidates every downstream result', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify = { ...task.nodes.clarify!, status: 'completed', hasResult: true };
    task.nodes.solution = { ...task.nodes.solution!, status: 'completed', hasResult: true };
    task.nodes.plan = { ...task.nodes.plan!, status: 'completed', hasResult: true };
    task.nodes['development-list'] = {
      title: '主列表开发', phase: 'development', dependsOn: ['plan'],
      skill: task.developmentSkill, requiresApproval: false, outputs: ['artifacts/development/development-list/result.md'],
      status: 'completed', hasResult: true,
      generatedFromPlan: true, contextPath: 'artifacts/plan/units/development-list.yaml',
    };

    const next = transitionNode(task, 'clarify', { type: 'start', runId: 'rerun-01' });

    expect(next.nodes.clarify!.status).toBe('running');
    expect(next.nodes.solution!.status).toBe('pending');
    expect(next.nodes.plan!.status).toBe('pending');
    expect(next.nodes['development-list']).toBeUndefined();
  });

  it('source refresh restarts the workflow from clarification', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify = { ...task.nodes.clarify!, status: 'completed', hasResult: true };
    task.nodes.solution = { ...task.nodes.solution!, status: 'completed', hasResult: true };
    task.nodes.plan = { ...task.nodes.plan!, status: 'completed', hasResult: true };

    const next = restartDependentsForSourceChange(task, 'intake', '需求来源已更新');

    expect(next.nodes.clarify!.status).toBe('ready');
    expect(next.nodes.solution!.status).toBe('pending');
    expect(next.nodes.plan!.status).toBe('pending');
  });
});
