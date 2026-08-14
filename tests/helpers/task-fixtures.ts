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
      clarify: node('澄清需求', 'clarify', ['intake'], 'ready', true, ['artifacts/brief.md'], createSkillLock('requirements-clarification')),
      solution: node('形成技术方案', 'solution', ['clarify'], 'pending', false, ['artifacts/solution.md'], createSkillLock('technical-solution')),
      plan: node('制定实施计划', 'plan', ['solution'], 'pending', true, ['artifacts/implementation-plan.md', 'artifacts/implementation-context.md', 'artifacts/work-breakdown.yaml'], createSkillLock('implementation-planning')),
      implement: { ...node('完成实现', 'implement', ['plan'], 'pending', false, ['artifacts/implementation.md'], createSkillLock('typescript-web-implementation')), contextPath: 'artifacts/implementation-context.md', allowedPaths: [] },
      verify: node('工程验证', 'verify', ['implement'], 'pending', false, ['artifacts/verification.md'], createSkillLock('web-verification')),
      test: node('测试验证', 'test', ['verify'], 'pending', true, ['artifacts/test-report.md', 'artifacts/acceptance-results.yaml'], createSkillLock('acceptance-testing')),
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
    ...(skill ? { skill } : {}),
  };
}
