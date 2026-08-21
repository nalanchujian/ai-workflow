import { describe, expect, it } from 'vitest';

import { TaskSchema } from '../../src/domain/task.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';

describe('TaskSchema', () => {
  it('accepts the simplified task without decisions, impact graphs, or delivery status', () => {
    const task = createSevenPhaseTask();
    expect(TaskSchema.parse(task)).toMatchObject({ schemaVersion: 'aiw.task/v3', status: 'active' });
  });

  it('rejects a task graph with a dependency cycle', () => {
    const task = createSevenPhaseTask();
    task.nodes.solution!.dependsOn = ['plan'];
    expect(() => TaskSchema.parse(task)).toThrow(/cycle/i);
  });

  it('rejects an executable node without a locked skill', () => {
    const task = createSevenPhaseTask();
    delete task.nodes.clarify!.skill;
    expect(() => TaskSchema.parse(task)).toThrow(/技能/);
  });

  it('rejects obsolete task protocol fields', () => {
    const input = { ...createSevenPhaseTask(), decisions: [], impactGraph: {}, deliveryStatus: 'not_assessed' };
    expect(() => TaskSchema.parse(input)).toThrow(/Unrecognized key/);
  });
});
