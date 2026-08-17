import { describe, expect, it } from 'vitest';

import { registeredDecisionFactPaths, TaskSchema } from '../../src/domain/task.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';

describe('TaskSchema', () => {
  it('rejects a task graph with a dependency cycle', () => {
    const task = createSevenPhaseTask();
    task.nodes.solution.dependsOn = ['plan'];

    expect(() => TaskSchema.parse(task)).toThrow(/cycle/i);
  });

  it('rejects an executable node without a locked skill', () => {
    const task = createSevenPhaseTask();
    delete task.nodes.clarify.skill;

    expect(() => TaskSchema.parse(task)).toThrow(/skill/i);
  });

  it('exposes only fact paths registered by the task decisions', () => {
    const task = createSevenPhaseTask();
    task.decisions = [{
      id: 'DEC-API-01', revision: 1, status: 'resolved', optionId: 'use-api', actor: 'tester',
      at: '2026-08-17T00:00:00.000Z', factPath: 'decisions/DEC-API-01/r1.yaml',
    }];

    expect(registeredDecisionFactPaths(task)).toEqual(['decisions/DEC-API-01/r1.yaml']);
    expect(registeredDecisionFactPaths(task)).not.toContain('decisions/unknown/r1.yaml');
  });
});
