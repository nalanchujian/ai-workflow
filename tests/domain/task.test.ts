import { describe, expect, it } from 'vitest';

import { TaskSchema } from '../../src/domain/task.js';
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
});
