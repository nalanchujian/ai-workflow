import type { NodeStatus, SkillLock, Task } from '../../src/domain/task.js';

export function createSkillLock(name: string): SkillLock {
  return {
    name,
    version: '1.0.0',
    registrySource: { url: 'git@example.test/agent-skills.git', revision: 'a1b2c3d4' },
    sha256: 'a'.repeat(64),
    methodSources: [{
      id: 'superpowers:brainstorming', source: 'bundled:superpowers', version: '6.2.0',
      revision: 'b'.repeat(40), sha256: 'b'.repeat(64),
    }],
  };
}

/** A new task before its approved plan has materialized development units. */
export function createSevenPhaseTask(): Task {
  return {
    schemaVersion: 'aiw.task/v3',
    stateVersion: 0,
    id: 'refund-123',
    title: '实现退款功能',
    repository: '.',
    status: 'active',
    skillProfile: {
      name: 'standard-web-feature', version: '1.0.0',
      registrySource: { url: 'git@example.test/agent-skills.git', revision: 'a1b2c3d4' },
      sha256: 'c'.repeat(64),
    },
    developmentSkill: createSkillLock('typescript-web-implementation'),
    sources: {},
    nodes: {
      intake: node('接入资料', 'intake', [], 'completed', false, ['sources/requirements/current/snapshot.md']),
      clarify: node('澄清需求', 'clarify', ['intake'], 'ready', true, [
        'artifacts/clarify/fact-register.yaml', 'artifacts/clarify/decision-register.yaml',
      ], createSkillLock('requirements-clarification')),
      solution: node('形成技术方案', 'solution', ['clarify'], 'pending', false, [
        'artifacts/solution/solution.md',
      ], createSkillLock('technical-solution')),
      plan: node('制定开发计划', 'plan', ['solution'], 'pending', true, [
        'artifacts/plan/development-plan.yaml',
      ], createSkillLock('implementation-planning')),
    },
    approvalRefs: [],
    events: [],
  };
}

function node(
  title: string,
  phase: Task['nodes'][string]['phase'],
  dependsOn: string[],
  status: NodeStatus,
  requiresApproval: boolean,
  outputs: string[],
  skill?: SkillLock,
): Task['nodes'][string] {
  return {
    title, phase, dependsOn, status, hasResult: status === 'completed', outputs, requiresApproval,
    ...(skill === undefined ? {} : { skill }),
  };
}
