import { describe, expect, it } from 'vitest';

import { invalidateDependents, overwriteCleanupPaths, reconcileDecisionBlocks, transitionNode } from '../../src/services/task-state-machine.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';

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

  it('allows a failed node to be started again without creating a human revision', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'failed';

    const next = transitionNode(task, 'solution', { type: 'start', runId: 'retry-run' });

    expect(next.nodes.solution.status).toBe('running');
    expect(next.events).toContainEqual(expect.objectContaining({ type: 'start', nodeId: 'solution', runId: 'retry-run' }));
  });

  it('allows a completed stage to be run again and resets all active downstream state', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'completed';
    task.nodes.plan.status = 'completed';
    task.nodes.implement.status = 'completed';
    task.nodes.verify.status = 'completed';
    task.nodes.test.status = 'awaiting_approval';
    task.approvalRefs = ['approvals/clarify/r1.yaml', 'approvals/plan/r1.yaml', 'approvals/test/r1.yaml'];
    task.decisions = [{
      id: 'DEC-API-01', revision: 1, status: 'resolved', optionId: 'mock', actor: 'tester', at: '2026-08-17T00:00:00.000Z', factPath: 'decisions/DEC-API-01/r1.yaml',
    }];

    const next = transitionNode(task, 'clarify', { type: 'start', runId: 'replace-clarify-run' });

    expect(next.nodes.clarify.status).toBe('running');
    expect(next.nodes.solution.status).toBe('pending');
    expect(next.nodes.plan.status).toBe('pending');
    expect(next.nodes.implement.status).toBe('pending');
    expect(next.nodes.verify.status).toBe('pending');
    expect(next.nodes.test.status).toBe('pending');
    expect(next.approvalRefs).toEqual([]);
    expect(next.decisions).toEqual([]);
  });

  it('allows a completed plan to be run again and directly replaces its downstream graph', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'completed';
    task.nodes.plan.status = 'completed';
    task.nodes.implement.status = 'superseded';
    task.nodes['implement-export'] = {
      ...task.nodes.implement,
      title: '导出能力',
      status: 'ready',
      dependsOn: ['plan'],
      generatedFromPlanRevision: 1,
    };
    task.nodes.verify.status = 'pending';
    task.nodes.verify.dependsOn = ['implement-export'];

    const next = transitionNode(task, 'plan', { type: 'start', runId: 'replace-plan-run' });

    expect(next.nodes.plan.status).toBe('running');
    expect(next.nodes['implement-export']).toBeUndefined();
    expect(next.nodes.implement).toMatchObject({ status: 'pending', dependsOn: ['plan'] });
    expect(next.nodes.verify).toMatchObject({ status: 'pending', dependsOn: ['implement'] });
  });

  it('lists only current and downstream task facts for overwrite cleanup', () => {
    const task = createSevenPhaseTask();
    task.nodes.implement!.contextPath = 'artifacts/work-units/r1/implement-export.md';

    const paths = overwriteCleanupPaths(task, 'implement');

    expect(paths).toContain('artifacts/implementation.md');
    expect(paths).toContain('artifacts/work-units/r1/implement-export.md');
    expect(paths).toContain('artifacts/verification.md');
    expect(paths).toContain('artifacts/test-report.md');
    expect(paths).toContain('handoffs/implement');
    expect(paths).toContain('approvals/test');
    expect(paths).not.toContain('artifacts/brief.md');
    expect(paths).not.toContain('sources/requirements/r1/snapshot.md');
  });

});
