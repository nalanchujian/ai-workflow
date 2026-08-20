import { describe, expect, it } from 'vitest';

import { invalidateDependents, reconcileDecisionBlocks, restartDependentsForSourceChange, selectWorkflowPath, transitionNode } from '../../src/services/task-state-machine.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';

describe('task state machine', () => {
  it('marks the task completed when every node is completed', () => {
    const task = createSevenPhaseTask();
    for (const node of Object.values(task.nodes)) {
      node.status = 'completed';
    }
    task.nodes.implement.status = 'running';
    task.nodes.implement.requiresApproval = false;

    const next = transitionNode(task, 'implement', { type: 'succeed', runId: 'delivery-run-1', outputs: [], evidencePath: 'runs/delivery-run-1/change-evidence.json' });

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
    task.nodes.implement.decisionRefs = ['DEC-API-01'];
    task.decisions = [{
      id: 'DEC-API-01', status: 'resolved', optionId: 'wait-api', actor: 'backend-lead',
      at: '2026-08-14T00:00:00.000Z', factPath: 'decisions/DEC-API-01.yaml',
    }];

    const next = reconcileDecisionBlocks(task, 'DEC-API-01');

    expect(next.nodes.implement.status).toBe('ready');
    expect(next.status).toBe('active');
  });

  it('invalidates every started descendant while retaining untouched pending descendants', () => {
    const task = createSevenPhaseTask();
    task.nodes.solution.status = 'completed';
    task.nodes.plan.status = 'awaiting_approval';
    task.nodes.implement.status = 'ready';

    const next = invalidateDependents(task, 'clarify', 'requirements changed');

    expect(next.nodes.solution.status).toBe('invalidated');
    expect(next.nodes.plan.status).toBe('invalidated');
    expect(next.nodes.implement.status).toBe('invalidated');
  });

  it('moves an approval-required node to awaiting approval after a successful run', () => {
    const task = createSevenPhaseTask();

    const running = transitionNode(task, 'clarify', { type: 'start', runId: 'run-01' });
    const next = transitionNode(running, 'clarify', {
      type: 'succeed', runId: 'clarify-run-1', evidencePath: 'runs/clarify-run-1/change-evidence.json',
      outputs: [{ path: 'artifacts/brief.md', sha256: 'd'.repeat(64) }],
    });

    expect(next.nodes.clarify.status).toBe('awaiting_approval');
    expect(next.nodes.clarify.hasResult).toBe(true);
  });

  it('approves a node and unlocks its direct dependent', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'awaiting_approval';

    const next = transitionNode(task, 'clarify', { type: 'approve', actor: 'tech-lead' });

    expect(next.nodes.clarify.status).toBe('completed');
    expect(next.nodes.solution.status).toBe('ready');
  });

  it('routes an eligible task directly from clarify to plan for quick delivery', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'awaiting_approval';
    task.nodes.clarify.hasResult = true;

    const selected = selectWorkflowPath(task, {
      id: 'quick', assessmentPath: 'workflow-assessments/clarify.yaml', assessmentSha256: 'e'.repeat(64),
      policyVersion: 'quick-standard/v1', selectedAt: '2026-08-19T00:00:00.000Z', selectedBy: 'tech-lead',
    });
    const approved = transitionNode(selected, 'clarify', { type: 'approve', actor: 'tech-lead' });

    expect(approved.nodes.solution.status).toBe('superseded');
    expect(approved.nodes.plan).toMatchObject({ status: 'ready', dependsOn: ['clarify'] });
  });

  it('clears the quick selection and restores standard topology when a source changes', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.clarify.hasResult = true;
    const quick = selectWorkflowPath(task, {
      id: 'quick', assessmentPath: 'workflow-assessments/clarify.yaml', assessmentSha256: 'e'.repeat(64),
      policyVersion: 'quick-standard/v1', selectedAt: '2026-08-19T00:00:00.000Z', selectedBy: 'tech-lead',
    });

    const restarted = restartDependentsForSourceChange(quick, 'intake', '需求来源已更新');

    expect(restarted.workflowPath).toBeUndefined();
    expect(restarted.nodes.clarify.status).toBe('ready');
    expect(restarted.nodes.solution).toMatchObject({ status: 'pending', dependsOn: ['clarify'] });
    expect(restarted.nodes.plan).toMatchObject({ status: 'pending', dependsOn: ['solution'] });
  });

  it('allows a failed node to be started again without adding an operation version', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'failed';

    const next = transitionNode(task, 'solution', { type: 'start', runId: 'retry-run' });

    expect(next.nodes.solution.status).toBe('running');
    expect(next.events).toContainEqual(expect.objectContaining({ type: 'start', nodeId: 'solution', runId: 'retry-run' }));
  });

  it('allows a cancelled node to be started again and restores a runnable task state', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'cancelled';

    const next = transitionNode(task, 'solution', { type: 'start', runId: 'retry-cancelled-run' });

    expect(next.nodes.solution.status).toBe('running');
    expect(next.status).toBe('active');
    expect(next.events).toContainEqual(expect.objectContaining({ type: 'start', nodeId: 'solution', runId: 'retry-cancelled-run' }));
  });

  it('allows a completed stage to be run again and resets all active downstream state', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'completed';
    task.nodes.plan.status = 'completed';
    task.nodes.implement.status = 'completed';
    task.approvalRefs = ['approvals/clarify.yaml', 'approvals/plan.yaml', 'approvals/implement.yaml'];
    task.decisions = [{
      id: 'DEC-API-01', status: 'resolved', optionId: 'mock', actor: 'tester', at: '2026-08-17T00:00:00.000Z', factPath: 'decisions/DEC-API-01.yaml',
    }];

    const next = transitionNode(task, 'clarify', { type: 'start', runId: 'replace-clarify-run' });

    expect(next.nodes.clarify.status).toBe('running');
    expect(next.nodes.solution.status).toBe('pending');
    expect(next.nodes.plan.status).toBe('pending');
    expect(next.nodes.implement.status).toBe('pending');
    expect(next.approvalRefs).toEqual([]);
    expect(next.decisions).toEqual([]);
  });

  it('allows a completed plan to be run again and directly replaces its downstream graph', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'completed';
    task.nodes.plan.status = 'completed';
    task.nodes.implement.status = 'superseded';
    task.nodes['delivery-export'] = {
      ...task.nodes.implement,
      title: '导出能力',
      status: 'ready',
      dependsOn: ['plan'],
      generatedFromPlan: true,
      workUnitId: 'export',
      acceptanceRefs: ['AC-01'],
      decisionRefs: [],
      verificationPlan: [{ id: 'TEST-EXPORT-01', profile: 'vitest', evidenceType: 'unit', acceptanceRefs: ['AC-01'], command: 'pnpm test' }],
    };

    const next = transitionNode(task, 'plan', { type: 'start', runId: 'replace-plan-run' });

    expect(next.nodes.plan.status).toBe('running');
    expect(next.nodes['delivery-export']).toMatchObject({ status: 'superseded' });
    expect(next.nodes.implement).toMatchObject({ status: 'pending', dependsOn: ['plan'] });
  });

  it('keeps historical output declarations when a completed node is re-run', () => {
    const task = createSevenPhaseTask();
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'completed';
    task.nodes.solution.hasResult = true;

    const next = transitionNode(task, 'solution', { type: 'start', runId: 'solution-run-2' });

    expect(next.nodes.solution.outputs).toEqual(['artifacts/solution.md']);
    expect(next.nodes.solution.status).toBe('running');
    expect(next.nodes.plan.status).toBe('pending');
  });

});
