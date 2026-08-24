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

  it('accepts an optional independent design-analysis node', () => {
    const task = createSevenPhaseTask();
    task.designInput = {
      provider: 'figma',
      url: 'https://www.figma.com/design/file-key/file-name?node-id=9272-292810',
      fileKey: 'file-key',
      nodeId: '9272:292810',
    };
    task.nodes['design-analysis'] = {
      title: '分析设计稿', phase: 'design', dependsOn: ['intake'],
      skill: createSevenPhaseTask().nodes.clarify!.skill,
      requiresApproval: false, status: 'ready', hasResult: false,
      outputs: [
        'artifacts/design/design-catalog.yaml',
        'artifacts/design/design-rules.yaml',
        'artifacts/design/design-context.md',
      ],
    };
    task.nodes.clarify!.dependsOn = ['design-analysis'];

    expect(TaskSchema.parse(task).nodes['design-analysis']).toMatchObject({ phase: 'design', dependsOn: ['intake'] });
  });
});
