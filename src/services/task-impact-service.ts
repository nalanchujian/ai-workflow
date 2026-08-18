import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse, stringify } from 'yaml';

import { AcceptanceCatalogSchema, type AcceptanceCatalog } from '../domain/acceptance-catalog.js';
import { DecisionRegisterSchema, type DecisionRegister } from '../domain/decision-register.js';
import { FactRegisterSchema, type FactRegister } from '../domain/fact-register.js';
import { ImpactGraphSchema, type ImpactGraph } from '../domain/impact-graph.js';
import { completedArtifactPath } from '../domain/handoff.js';
import { type Task } from '../domain/task.js';
import { readWorkBreakdown, type WorkBreakdown } from './implementation-work-planner.js';
import { TaskStore } from './task-store.js';

export class TaskImpactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskImpactError';
  }
}

export type ClarificationImpactArtifacts = {
  facts: FactRegister;
  decisions: DecisionRegister;
  acceptance: AcceptanceCatalog;
};

export function validateClarificationImpactArtifacts(input: {
  task: Task;
  facts: FactRegister;
  decisions: DecisionRegister;
  acceptance: AcceptanceCatalog;
}): void {
  const factIds = new Set(input.facts.items.map((item) => item.id));
  const acceptanceIds = new Set(input.acceptance.items.map((item) => item.id));
  const sourcePaths = new Map(Object.entries(input.task.sources).map(([sourceId, source]) => [sourceId, source.snapshotPath]));
  const errors: string[] = [];

  for (const fact of input.facts.items) {
    for (const evidence of fact.evidence) {
      const expectedPath = sourcePaths.get(evidence.sourceId);
      if (expectedPath === undefined) {
        errors.push(`${fact.id} 引用了未知来源 ${evidence.sourceId}`);
      } else if (evidence.path !== expectedPath) {
        errors.push(`${fact.id} 的来源证据必须引用 ${evidence.sourceId} 当前快照 ${expectedPath}`);
      }
    }
  }

  const decisionFactRefs = new Set<string>();
  for (const decision of input.decisions.items) {
    for (const factRef of decision.factRefs) {
      decisionFactRefs.add(factRef);
      if (!factIds.has(factRef)) errors.push(`${decision.id} 引用了不存在的事实 ${factRef}`);
    }
    for (const acceptanceRef of decision.affects.acceptanceRefs) {
      if (!acceptanceIds.has(acceptanceRef)) errors.push(`${decision.id} 引用了不存在的验收项 ${acceptanceRef}`);
    }
  }

  for (const acceptance of input.acceptance.items) {
    for (const factRef of acceptance.factRefs) {
      if (!factIds.has(factRef)) errors.push(`${acceptance.id} 引用了不存在的事实 ${factRef}`);
    }
  }

  for (const fact of input.facts.items) {
    if (fact.kind !== 'confirmed' && !decisionFactRefs.has(fact.id)) {
      errors.push(`${fact.id} 是${factKindLabel(fact.kind)}，必须由一个决策项显式处理`);
    }
  }

  if (errors.length > 0) throw new TaskImpactError(`事实与影响关系无效：${[...new Set(errors)].join('；')}`);
}

export async function readClarificationImpactArtifacts(task: Task, taskStore: TaskStore): Promise<ClarificationImpactArtifacts> {
  const clarify = task.nodes.clarify;
  if (clarify === undefined || clarify.revision === 0) {
    throw new TaskImpactError('需求澄清尚未生成事实、决策和验收产物');
  }
  const directory = taskStore.taskDirectory(task.id);
  const [factsContent, decisionsContent, acceptanceContent] = await Promise.all([
    readFile(join(directory, completedArtifactPath('clarify', clarify, 'artifacts/fact-register.yaml')), 'utf8'),
    readFile(join(directory, completedArtifactPath('clarify', clarify, 'artifacts/decision-register.yaml')), 'utf8'),
    readFile(join(directory, completedArtifactPath('clarify', clarify, 'artifacts/acceptance.yaml')), 'utf8'),
  ]);
  try {
    const artifacts = {
      facts: FactRegisterSchema.parse(parse(factsContent)),
      decisions: DecisionRegisterSchema.parse(parse(decisionsContent)),
      acceptance: AcceptanceCatalogSchema.parse(parse(acceptanceContent)),
    };
    validateClarificationImpactArtifacts({ task, ...artifacts });
    return artifacts;
  } catch (error) {
    if (error instanceof TaskImpactError) throw error;
    throw new TaskImpactError(`无法读取事实与影响关系：${error instanceof Error ? error.message : '格式无效'}`);
  }
}

export async function validatePlanImpact(task: Task, taskStore: TaskStore, breakdown?: WorkBreakdown): Promise<void> {
  const [clarify, currentBreakdown] = await Promise.all([
    readClarificationImpactArtifacts(task, taskStore),
    breakdown === undefined ? readWorkBreakdown(task, taskStore) : Promise.resolve(breakdown),
  ]);
  const factIds = new Set(clarify.facts.items.map((item) => item.id));
  const decisionsById = new Map(clarify.decisions.items.map((item) => [item.id, item]));
  const acceptanceById = new Map(clarify.acceptance.items.map((item) => [item.id, item]));
  const errors: string[] = [];

  for (const unit of currentBreakdown.units) {
    for (const factRef of unit.factRefs) {
      if (!factIds.has(factRef)) errors.push(`工作单元 ${unit.id} 引用了不存在的事实 ${factRef}`);
    }
    for (const decisionRef of unit.decisionRefs) {
      if (!decisionsById.has(decisionRef)) errors.push(`工作单元 ${unit.id} 引用了不存在的决策 ${decisionRef}`);
    }
    const requiredFacts = new Set([
      ...unit.acceptanceRefs.flatMap((id) => acceptanceById.get(id)?.factRefs ?? []),
      ...unit.decisionRefs.flatMap((id) => decisionsById.get(id)?.factRefs ?? []),
    ]);
    const missingFacts = [...requiredFacts].filter((id) => !unit.factRefs.includes(id));
    if (missingFacts.length > 0) errors.push(`工作单元 ${unit.id} 缺少其验收或决策依赖的事实：${missingFacts.join('、')}`);

    const requiredDecisions = clarify.decisions.items
      .filter((item) => item.affects.workUnits.includes(unit.id) || item.affects.acceptanceRefs.some((id) => unit.acceptanceRefs.includes(id)))
      .map((item) => item.id);
    const missingDecisions = requiredDecisions.filter((id) => !unit.decisionRefs.includes(id));
    if (missingDecisions.length > 0) errors.push(`工作单元 ${unit.id} 缺少关联决策：${missingDecisions.join('、')}`);
  }

  if (errors.length > 0) throw new TaskImpactError(`实施工作单元影响关系无效：${[...new Set(errors)].join('；')}`);
}

export async function materializeImpactGraph(task: Task, taskStore: TaskStore): Promise<{ path: string; content: string; sha256: string }> {
  const plan = task.nodes.plan;
  if (plan === undefined || plan.revision === 0) throw new TaskImpactError('计划尚未生成，无法创建影响图');
  const [clarify, breakdown] = await Promise.all([
    readClarificationImpactArtifacts(task, taskStore),
    readWorkBreakdown(task, taskStore),
  ]);
  await validatePlanImpact(task, taskStore, breakdown);
  const deliveriesByUnit = new Map(
    Object.entries(task.nodes)
      .filter(([, node]) => node.phase === 'implement' && node.generatedFromPlanRevision === plan.revision && node.workUnitId !== undefined && node.status !== 'superseded')
      .map(([nodeId, node]) => [node.workUnitId!, nodeId]),
  );
  const coverageByAcceptance = new Map(breakdown.acceptanceCoverage.map((item) => [item.acceptanceId, item]));
  const decisionsByFact = new Map<string, string[]>();
  for (const decision of clarify.decisions.items) {
    for (const factRef of decision.factRefs) {
      decisionsByFact.set(factRef, [...(decisionsByFact.get(factRef) ?? []), decision.id]);
    }
  }
  const graph = ImpactGraphSchema.parse({
    schemaVersion: 'aiw.impact-graph/v1',
    taskId: task.id,
    clarifyRevision: task.nodes.clarify!.revision,
    planRevision: plan.revision,
    facts: clarify.facts.items.map((fact) => {
      const decisionIds = unique(decisionsByFact.get(fact.id) ?? []);
      const acceptanceRefs = unique([
        ...clarify.acceptance.items.filter((item) => item.factRefs.includes(fact.id)).map((item) => item.id),
        ...clarify.decisions.items.filter((item) => item.factRefs.includes(fact.id)).flatMap((item) => item.affects.acceptanceRefs),
      ]);
      const workUnitIds = unique(breakdown.units.filter((unit) => unit.factRefs.includes(fact.id) || unit.acceptanceRefs.some((id) => acceptanceRefs.includes(id)) || unit.decisionRefs.some((id) => decisionIds.includes(id))).map((unit) => unit.id));
      return {
        id: fact.id,
        kind: fact.kind,
        sourceIds: unique(fact.evidence.map((evidence) => evidence.sourceId)),
        decisionIds,
        acceptanceRefs,
        workUnitIds,
        deliveryNodeIds: workUnitIds.map((id) => deliveriesByUnit.get(id)).filter((id): id is string => id !== undefined),
      };
    }),
    decisions: clarify.decisions.items.map((decision) => ({
      id: decision.id,
      factRefs: decision.factRefs,
      acceptanceRefs: decision.affects.acceptanceRefs,
      workUnitIds: decision.affects.workUnits,
      deliveryNodeIds: decision.affects.workUnits.map((id) => deliveriesByUnit.get(id)).filter((id): id is string => id !== undefined),
    })),
    acceptance: clarify.acceptance.items.map((acceptance) => {
      const coverage = coverageByAcceptance.get(acceptance.id);
      const workUnitId = coverage?.workUnitIds[0];
      return {
        id: acceptance.id,
        factRefs: acceptance.factRefs,
        decisionIds: clarify.decisions.items.filter((decision) => decision.affects.acceptanceRefs.includes(acceptance.id)).map((decision) => decision.id),
        ...(workUnitId === undefined ? {} : { workUnitId }),
        ...(workUnitId === undefined || deliveriesByUnit.get(workUnitId) === undefined ? {} : { deliveryNodeId: deliveriesByUnit.get(workUnitId) }),
      };
    }),
    units: breakdown.units.map((unit) => ({
      id: unit.id,
      deliveryNodeId: deliveriesByUnit.get(unit.id) ?? missingDeliveryNode(unit.id),
      acceptanceRefs: unit.acceptanceRefs,
      factRefs: unit.factRefs,
      decisionIds: unit.decisionRefs,
      dependsOn: unit.dependsOn,
      verificationCommands: unit.verification,
    })),
  });
  const content = stringify(graph);
  return {
    path: `impact-graphs/plan-r${plan.revision}.yaml`,
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

export async function readCurrentImpactGraph(task: Task, taskStore: TaskStore): Promise<ImpactGraph | undefined> {
  const reference = task.impactGraph;
  if (reference === undefined) return undefined;
  try {
    const content = await readFile(join(taskStore.taskDirectory(task.id), reference.path), 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (sha256 !== reference.sha256) throw new Error('影响图内容哈希与 task.yaml 不一致');
    const graph = ImpactGraphSchema.parse(parse(content));
    if (graph.taskId !== task.id || graph.clarifyRevision !== reference.clarifyRevision || graph.planRevision !== reference.planRevision) {
      throw new Error('影响图身份或 revision 与 task.yaml 不一致');
    }
    return graph;
  } catch (error) {
    throw new TaskImpactError(`当前影响图无法使用：${error instanceof Error ? error.message : '无法读取'}`);
  }
}

export async function deliveryNodesImpactedByDecision(task: Task, taskStore: TaskStore, decisionId: string): Promise<string[]> {
  const graph = await readCurrentImpactGraph(task, taskStore);
  return graph?.decisions.find((decision) => decision.id === decisionId)?.deliveryNodeIds ?? [];
}

export async function deliveryNodesImpactedBySource(task: Task, taskStore: TaskStore, sourceId: string): Promise<string[]> {
  const graph = await readCurrentImpactGraph(task, taskStore);
  if (graph === undefined) return [];
  return unique(graph.facts.filter((fact) => fact.sourceIds.includes(sourceId)).flatMap((fact) => fact.deliveryNodeIds));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function missingDeliveryNode(unitId: string): never {
  throw new TaskImpactError(`工作单元 ${unitId} 未生成对应交付节点`);
}

function factKindLabel(kind: FactRegister['items'][number]['kind']): string {
  return ({ inferred: '推断', unresolved: '待确认事实', external_dependency: '外部依赖', confirmed: '已确认事实' })[kind];
}
