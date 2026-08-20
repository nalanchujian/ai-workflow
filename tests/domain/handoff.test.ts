import { describe, expect, it } from 'vitest';

import { artifactPath, handoffPath, outputPathsForNextRun, validateHandoff, validateHandoffFactReferences } from '../../src/domain/handoff.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';

describe('Handoff', () => {
  it('uses one current handoff path for a node', () => {
    expect(handoffPath('implement-orders')).toBe('handoffs/implement-orders.yaml');
  });

  it('writes each declared artifact to one current path', () => {
    const task = createSevenPhaseTask();
    const clarify = { ...task.nodes.clarify!, hasResult: true };

    expect(artifactPath('clarify', 'artifacts/brief.md')).toBe('artifacts/clarify/brief.md');
    expect(outputPathsForNextRun('clarify', clarify)).toContain('artifacts/clarify/brief.md');
    expect(outputPathsForNextRun('clarify', clarify)).toContain('handoffs/clarify.yaml');
  });

  it('accepts a structured handoff that identifies its node and evidence', () => {
    expect(() => validateHandoff(`schemaVersion: aiw.handoff/v1
taskId: task-123
nodeId: clarify
phase: clarify
summary: 已整理需求目标、范围和验收标准。
facts:
  - id: FACT-REFUND-01
    statement: 用户可以提交退款申请。
    evidence:
      - path: artifacts/brief.md
decisions: []
acceptance: []
changes: []
verification: []
openRisks: []
`, {
      taskId: 'task-123', nodeId: 'clarify', phase: 'clarify', evidencePaths: ['artifacts/brief.md'], decisionFactPaths: [],
    })).not.toThrow();
  });

  it('rejects evidence outside the permitted task facts', () => {
    expect(() => validateHandoff(`schemaVersion: aiw.handoff/v1
taskId: task-123
nodeId: clarify
phase: clarify
summary: 已整理需求目标、范围和验收标准。
facts:
  - id: FACT-REFUND-01
    statement: 用户可以提交退款申请。
    evidence:
      - path: artifacts/unknown.md
decisions: []
acceptance: []
changes: []
verification: []
openRisks: []
`, {
      taskId: 'task-123', nodeId: 'clarify', phase: 'clarify', evidencePaths: ['artifacts/brief.md'], decisionFactPaths: [],
    })).toThrow('交接包引用了不允许的证据');
  });

  it('uses the formal FACT and DEC identities and requires the recorded decision fact', () => {
    expect(() => validateHandoff(`schemaVersion: aiw.handoff/v1
taskId: task-123
nodeId: solution
phase: solution
summary: 已根据已确认的退款接口结论形成技术方案。
facts:
  - id: FACT-REFUND-01
    statement: 用户可以提交退款申请并查看处理结果。
    evidence:
      - path: artifacts/clarify/fact-register.yaml
decisions:
  - id: DEC-REFUND-API-01
    statement: 采用当前已确认的退款接口继续实施。
    evidence:
      - path: decisions/DEC-REFUND-API-01.yaml
acceptance: []
changes: []
verification: []
openRisks: []
`, {
      taskId: 'task-123',
      nodeId: 'solution',
      phase: 'solution',
      evidencePaths: ['artifacts/clarify/fact-register.yaml', 'decisions/DEC-REFUND-API-01.yaml'],
      decisionFactPaths: ['decisions/DEC-REFUND-API-01.yaml'],
    })).not.toThrow();
  });

  it('rejects a handoff decision without an immutable DEC fact reference', () => {
    expect(() => validateHandoff(`schemaVersion: aiw.handoff/v1
taskId: task-123
nodeId: solution
phase: solution
summary: 已根据已确认的退款接口结论形成技术方案。
facts:
  - id: FACT-REFUND-01
    statement: 用户可以提交退款申请并查看处理结果。
    evidence:
      - path: artifacts/clarify/fact-register.yaml
decisions:
  - id: DEC-REFUND-API-01
    statement: 采用当前已确认的退款接口继续实施。
    evidence:
      - path: artifacts/solution/solution.md
acceptance: []
changes: []
verification: []
openRisks: []
`, {
      taskId: 'task-123',
      nodeId: 'solution',
      phase: 'solution',
      evidencePaths: ['artifacts/clarify/fact-register.yaml', 'artifacts/solution/solution.md', 'decisions/DEC-REFUND-API-01.yaml'],
      decisionFactPaths: ['decisions/DEC-REFUND-API-01.yaml'],
    })).toThrow('必须引用当前决策事实');
  });

  it('requires handoff facts to use the current formal fact register', () => {
    const handoff = validateHandoff(`schemaVersion: aiw.handoff/v1
taskId: task-123
nodeId: solution
phase: solution
summary: 已根据正式事实登记形成技术方案。
facts:
  - id: FACT-UNKNOWN-01
    statement: 这是一项没有登记的事实，不应成为下游依据。
    evidence:
      - path: artifacts/clarify/fact-register.yaml
decisions: []
acceptance: []
changes: []
verification: []
openRisks: []
`, {
      taskId: 'task-123',
      nodeId: 'solution',
      phase: 'solution',
      evidencePaths: ['artifacts/clarify/fact-register.yaml'],
      decisionFactPaths: [],
    });

    expect(() => validateHandoffFactReferences(handoff, ['FACT-REFUND-01'])).toThrow('未关联当前正式事实登记');
  });
});
