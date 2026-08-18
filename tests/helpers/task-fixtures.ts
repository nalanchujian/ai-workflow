import type { NodeStatus, SkillLock, Task } from '../../src/domain/task.js';

export function createSkillLock(name: string): SkillLock {
  return {
    name,
    version: '1.0.0',
    registrySource: {
      url: 'git@example.test/agent-skills.git',
      revision: 'a1b2c3d4',
    },
    sha256: 'a'.repeat(64),
    methodSources: [
      {
        id: 'superpowers:brainstorming',
        source: 'bundled:superpowers',
        version: '6.2.0',
        revision: 'b'.repeat(40),
        sha256: 'b'.repeat(64),
      },
    ],
  };
}

/**
 * A task before its approved plan has materialized delivery units.
 * The legacy name is intentionally retained only for test import stability.
 */
export function createSevenPhaseTask(): Task {
  return {
    schemaVersion: 'aiw.task/v2',
    id: 'refund-123',
    title: '实现退款功能',
    repository: '.',
    status: 'active',
    deliveryStatus: 'not_assessed',
    skillProfile: {
      name: 'standard-web-feature',
      version: '1.0.0',
      registrySource: {
        url: 'git@example.test/agent-skills.git',
        revision: 'a1b2c3d4',
      },
      sha256: 'c'.repeat(64),
    },
    sources: {},
    nodes: {
      intake: node('接入资料', 'intake', [], 'completed', false, ['sources/requirements/r1/snapshot.md']),
      clarify: node('澄清需求', 'clarify', ['intake'], 'ready', true, ['artifacts/brief.md', 'artifacts/questions.md', 'artifacts/fact-register.yaml', 'artifacts/acceptance.md', 'artifacts/acceptance.yaml', 'artifacts/decision-register.yaml'], createSkillLock('requirements-clarification')),
      solution: node('形成技术方案', 'solution', ['clarify'], 'pending', false, ['artifacts/solution.md'], createSkillLock('technical-solution')),
      plan: node('制定实施计划', 'plan', ['solution'], 'pending', true, ['artifacts/implementation-plan.md', 'artifacts/work-breakdown.yaml'], createSkillLock('implementation-planning')),
      // This is an internal anchor.  Approved plans replace it with delivery-<unit> nodes.
      implement: node('交付业务单元', 'implement', ['plan'], 'pending', true, ['artifacts/delivery.md', 'artifacts/test-results.yaml', 'artifacts/acceptance-results.yaml'], createSkillLock('typescript-web-implementation')),
    },
    approvalRefs: [],
    decisions: [],
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
    title,
    phase,
    dependsOn,
    status,
    revision: 0,
    outputs,
    requiresApproval,
    acceptanceRefs: [],
    decisionRefs: [],
    verificationCommands: phase === 'implement' ? ['pnpm test'] : [],
    ...(skill ? { skill } : {}),
  };
}
