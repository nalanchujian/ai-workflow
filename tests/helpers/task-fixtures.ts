import type { NodeStatus, SkillLock, Task } from '../../src/domain/task.js';

export function createSkillLock(name: string): SkillLock {
  return {
    name,
    version: '1.0.0',
    registrySource: { url: 'git@example.test/agent-skills.git', revision: 'a1b2c3d4' },
    sha256: 'a'.repeat(64),
  };
}

/** A new task before its approved plan has materialized development units. */
export function createSevenPhaseTask(): Task {
  return {
    schemaVersion: 'aiw.task/v5',
    stateVersion: 0,
    id: 'refund-123',
    title: '实现退款功能',
    repository: '.',
    status: 'active',
    skillProfile: {
      name: 'standard-web-feature',
      registrySource: { url: 'git@example.test/agent-skills.git', revision: 'a1b2c3d4' },
      sha256: 'c'.repeat(64),
    },
    developmentSkills: [createSkillLock('typescript-web-implementation')],
    inputs: { requirementUrl: 'https://docs.example.test/requirements', apiDocuments: { status: 'not-asked' }, design: { status: 'not-asked' } },
    sources: {},
    nodes: {
      'requirement-analysis': node('澄清需求', 'requirement-analysis', [], 'ready', true, [
        'artifacts/requirement-analysis/fact-register.yaml', 'artifacts/requirement-analysis/decision-register.yaml',
      ], createSkillLock('requirement-analysis')),
      solution: node('形成技术方案', 'solution', ['requirement-analysis'], 'pending', false, [
        'artifacts/solution/solution.md',
      ], createSkillLock('technical-solution')),
      plan: node('制定开发计划', 'plan', ['solution'], 'pending', false, [
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
    skills: skill === undefined ? [createSkillLock('fallback-skill')] : [skill],
  };
}
