import { describe, expect, it } from 'vitest';

import { TaskSchema } from '../../src/domain/task.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';

describe('TaskSchema', () => {
  it('accepts the simplified task without decisions, impact graphs, or delivery status', () => {
    const task = createSevenPhaseTask();
    expect(TaskSchema.parse(task)).toMatchObject({ schemaVersion: 'aiw.task/v6', status: 'active' });
  });

  it('rejects a workflow profile lock with an independent profile version', () => {
    const task = createSevenPhaseTask();
    (task.skillProfile as { version?: string }).version = '1.0.0';

    expect(() => TaskSchema.parse(task)).toThrow(/Unrecognized key/);
  });

  it('rejects a task graph with a dependency cycle', () => {
    const task = createSevenPhaseTask();
    task.nodes.solution!.dependsOn = ['plan'];
    expect(() => TaskSchema.parse(task)).toThrow(/cycle/i);
  });

  it('rejects an executable node without a locked skill', () => {
    const task = createSevenPhaseTask();
    task.nodes['requirement-analysis']!.skills = [];
    expect(() => TaskSchema.parse(task)).toThrow(/skills/);
  });

  it('rejects obsolete task protocol fields', () => {
    const input = { ...createSevenPhaseTask(), decisions: [], impactGraph: {}, deliveryStatus: 'not_assessed' };
    expect(() => TaskSchema.parse(input)).toThrow(/Unrecognized key/);
  });

  it('keeps design slicing as a fixed node before solution', () => {
    const task = createSevenPhaseTask();
    task.inputs.design = { status: 'provided', image: { id: 'main', originalName: 'main.png', imagePath: 'sources/design/main.png', mediaType: 'image/png' } };
    expect(TaskSchema.parse(task).nodes['design-slicing']).toMatchObject({ phase: 'design-slicing', dependsOn: ['api-analysis'] });
  });
});
