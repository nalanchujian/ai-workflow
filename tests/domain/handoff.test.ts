import { describe, expect, it } from 'vitest';

import { artifactPath, handoffPath, outputPathsForNextRun, validateHandoff } from '../../src/domain/handoff.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';

describe('Handoff', () => {
  it('uses a node revision as the immutable handoff path', () => {
    expect(handoffPath('implement-orders', 2)).toBe('handoffs/implement-orders/r2.yaml');
  });

  it('writes each declared artifact into a new immutable revision directory', () => {
    const task = createSevenPhaseTask();
    const clarify = { ...task.nodes.clarify!, revision: 1 };

    expect(artifactPath('clarify', 1, 'artifacts/brief.md')).toBe('artifacts/clarify/r1/brief.md');
    expect(outputPathsForNextRun('clarify', clarify)).toContain('artifacts/clarify/r2/brief.md');
    expect(outputPathsForNextRun('clarify', clarify)).toContain('handoffs/clarify/r2.yaml');
  });

  it('accepts a structured handoff that identifies its node and evidence', () => {
    expect(() => validateHandoff(`schemaVersion: aiw.handoff/v1
taskId: task-123
nodeId: clarify
phase: clarify
revision: 1
summary: 已整理需求目标、范围和验收标准。
facts:
  - id: FACT-01
    statement: 用户可以提交退款申请。
    evidence:
      - path: artifacts/brief.md
decisions: []
acceptance: []
changes: []
verification: []
openRisks: []
`, {
      taskId: 'task-123', nodeId: 'clarify', phase: 'clarify', revision: 1, evidencePaths: ['artifacts/brief.md'],
    })).not.toThrow();
  });

  it('rejects evidence outside the permitted task facts', () => {
    expect(() => validateHandoff(`schemaVersion: aiw.handoff/v1
taskId: task-123
nodeId: clarify
phase: clarify
revision: 1
summary: 已整理需求目标、范围和验收标准。
facts:
  - id: FACT-01
    statement: 用户可以提交退款申请。
    evidence:
      - path: artifacts/unknown.md
decisions: []
acceptance: []
changes: []
verification: []
openRisks: []
`, {
      taskId: 'task-123', nodeId: 'clarify', phase: 'clarify', revision: 1, evidencePaths: ['artifacts/brief.md'],
    })).toThrow('交接包引用了不允许的证据');
  });
});
