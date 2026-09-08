import { describe, expect, it } from 'vitest';

import { ignoreDevelopmentNode, invalidateNodeAndDependents, transitionNode } from '../../src/services/task-state-machine.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';

describe('task state machine', () => {
  it('moves clarification to approval without artifact hashes', () => {
    const task = createSevenPhaseTask();
    const running = transitionNode(task, 'requirement-analysis', { type: 'start', runId: 'run-01' });
    const next = transitionNode(running, 'requirement-analysis', {
      type: 'succeed', runId: 'run-01', outputs: [{ path: 'artifacts/requirement-analysis/fact-register.yaml' }],
    });
    expect(next.nodes['requirement-analysis']).toMatchObject({ status: 'awaiting_approval', hasResult: true });
  });

  it('approves clarification and unlocks solution', () => {
    const task = createSevenPhaseTask();
    task.nodes['requirement-analysis']!.status = 'awaiting_approval';
    const next = transitionNode(task, 'requirement-analysis', { type: 'approve', actor: 'developer' });
    expect(next.nodes.solution!.status).toBe('ready');
  });

  it('reruns an upstream node and invalidates every downstream result', () => {
    const task = createSevenPhaseTask();
    task.nodes['requirement-analysis'] = { ...task.nodes['requirement-analysis']!, status: 'completed', hasResult: true };
    task.nodes.solution = { ...task.nodes.solution!, status: 'completed', hasResult: true };
    task.nodes.plan = { ...task.nodes.plan!, status: 'completed', hasResult: true };
    task.nodes['development-list'] = {
      title: '主列表开发', phase: 'development', dependsOn: ['plan'],
      skills: task.developmentSkills, requiresApproval: false, outputs: ['artifacts/development/development-list/result.md'],
      status: 'completed', hasResult: true,
      generatedFromPlan: true, contextPath: 'artifacts/plan/units/development-list.yaml',
    };

    const next = transitionNode(task, 'requirement-analysis', { type: 'start', runId: 'rerun-01' });

    expect(next.nodes['requirement-analysis']!.status).toBe('running');
    expect(next.nodes.solution!.status).toBe('pending');
    expect(next.nodes.plan!.status).toBe('pending');
    expect(next.nodes['development-list']).toBeUndefined();
  });

  it('source refresh restarts the workflow from clarification', () => {
    const task = createSevenPhaseTask();
    task.nodes['requirement-analysis'] = { ...task.nodes['requirement-analysis']!, status: 'completed', hasResult: true };
    task.nodes.solution = { ...task.nodes.solution!, status: 'completed', hasResult: true };
    task.nodes.plan = { ...task.nodes.plan!, status: 'completed', hasResult: true };

    const next = invalidateNodeAndDependents(task, 'requirement-analysis', '需求来源已更新');

    expect(next.nodes['requirement-analysis']!.status).toBe('invalidated');
    expect(next.nodes.solution!.status).toBe('invalidated');
    expect(next.nodes.plan!.status).toBe('invalidated');
  });

  it('finishes a task when its last unfinished development unit is explicitly ignored', () => {
    const task = createSevenPhaseTask();
    task.nodes['requirement-analysis']!.status = 'completed';
    task.nodes.solution!.status = 'completed';
    task.nodes.plan!.status = 'completed';
    task.nodes['development-unit-share-link-theme'] = {
      title: '外部落地页开发', phase: 'development', dependsOn: ['plan'],
      skills: task.developmentSkills, requiresApproval: false, outputs: ['artifacts/development/development-unit-share-link-theme/result.md'],
      status: 'failed', hasResult: false,
      generatedFromPlan: true, contextPath: 'artifacts/plan/units/development-unit-share-link-theme.yaml',
    };

    const next = ignoreDevelopmentNode(task, 'development-unit-share-link-theme', '目标页面不在当前仓库', 'developer');

    expect(next.status).toBe('completed');
    expect(next.nodes['development-unit-share-link-theme']?.status).toBe('ignored');
    expect(next.events.at(-1)).toMatchObject({
      type: 'ignore', nodeId: 'development-unit-share-link-theme', note: '目标页面不在当前仓库', actor: 'developer',
    });
  });

  it('rejects ignoring a workflow node or a unit with unfinished dependents', () => {
    const task = createSevenPhaseTask();
    task.nodes['requirement-analysis']!.status = 'completed';
    task.nodes.solution!.status = 'completed';
    task.nodes.plan!.status = 'completed';
    task.nodes['development-unit-base-rules'] = {
      title: '基础开发', phase: 'development', dependsOn: ['plan'],
      skills: task.developmentSkills, requiresApproval: false, outputs: ['artifacts/development/development-unit-base-rules/result.md'],
      status: 'failed', hasResult: false,
      generatedFromPlan: true, contextPath: 'artifacts/plan/units/development-unit-base-rules.yaml',
    };
    task.nodes['development-unit-dependent-feature'] = {
      title: '依赖开发', phase: 'development', dependsOn: ['development-unit-base-rules'],
      skills: task.developmentSkills, requiresApproval: false, outputs: ['artifacts/development/development-unit-dependent-feature/result.md'],
      status: 'pending', hasResult: false,
      generatedFromPlan: true, contextPath: 'artifacts/plan/units/development-unit-dependent-feature.yaml',
    };

    expect(() => ignoreDevelopmentNode(task, 'plan', '不需要计划', 'developer')).toThrow('只能忽略开发单元');
    expect(() => ignoreDevelopmentNode(task, 'development-unit-base-rules', '不再实施', 'developer')).toThrow('仍有未完成的下游开发单元');
  });
});
