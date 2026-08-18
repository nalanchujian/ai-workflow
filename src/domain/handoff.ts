import { parse } from 'yaml';
import { z } from 'zod';

import { PhaseSchema, type Phase, type TaskNode } from './task.js';
import { formatSchemaDiagnostics } from './schema-diagnostics.js';
import { FactIdSchema } from './fact-register.js';
import { DecisionIdSchema } from './decision-register.js';

const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

const EvidenceSchema = z.object({
  path: z.string().regex(relativePathPattern, '证据必须是任务目录内的相对路径'),
  section: z.string().min(1).optional(),
}).strict();

export const HandoffSchema = z.object({
  schemaVersion: z.literal('aiw.handoff/v1'),
  taskId: z.string().min(1),
  nodeId: z.string().min(1),
  phase: PhaseSchema,
  revision: z.number().int().positive(),
  summary: z.string().min(12),
  facts: z.array(z.object({
    id: FactIdSchema,
    statement: z.string().min(8),
    evidence: z.array(EvidenceSchema).min(1),
  }).strict()).min(1),
  decisions: z.array(z.object({
    id: DecisionIdSchema,
    statement: z.string().min(8),
    evidence: z.array(EvidenceSchema).min(1),
  }).strict()),
  acceptance: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(['covered', 'pending', 'blocked', 'not-applicable']),
    evidence: z.array(EvidenceSchema).min(1),
  }).strict()),
  changes: z.array(z.object({
    path: z.string().regex(relativePathPattern, '变更必须是相对路径'),
    summary: z.string().min(8),
  }).strict()),
  verification: z.array(z.object({
    command: z.string().min(1),
    result: z.enum(['passed', 'failed', 'skipped', 'blocked']),
    evidence: z.array(EvidenceSchema).min(1),
  }).strict()),
  openRisks: z.array(z.object({
    description: z.string().min(8),
    impact: z.string().min(8),
  }).strict()),
}).strict();

export type Handoff = z.infer<typeof HandoffSchema>;

export function handoffPath(nodeId: string, revision: number): string {
  return `handoffs/${nodeId}/r${revision}.yaml`;
}

/**
 * A declared node output is a logical artifact name.  Every successful
 * revision receives its own physical path so a later re-run never overwrites
 * evidence that was previously reviewed or approved.
 */
export function artifactPath(nodeId: string, revision: number, declaredPath: string): string {
  if (!declaredPath.startsWith('artifacts/')) {
    throw new Error(`节点产物必须位于 artifacts/：${declaredPath}`);
  }
  return `artifacts/${nodeId}/r${revision}/${declaredPath.slice('artifacts/'.length)}`;
}

export function completedArtifactPath(nodeId: string, node: TaskNode, declaredPath: string): string {
  return artifactPath(nodeId, node.revision, declaredPath);
}

export function nextArtifactPath(nodeId: string, node: TaskNode, declaredPath: string): string {
  return artifactPath(nodeId, node.revision + 1, declaredPath);
}

export function declaredOutputPath(nodeId: string, node: TaskNode, revision: number, path: string): string | undefined {
  return node.outputs.find((declaredPath) => artifactPath(nodeId, revision, declaredPath) === path);
}

export function outputPathsForNextRun(nodeId: string, node: TaskNode): string[] {
  return [...node.outputs.map((path) => nextArtifactPath(nodeId, node, path)), handoffPath(nodeId, node.revision + 1)];
}

export function outputPathsForCompletedRun(nodeId: string, node: TaskNode): string[] {
  return [...node.outputs.map((path) => completedArtifactPath(nodeId, node, path)), handoffPath(nodeId, node.revision)];
}

export function validateHandoff(content: string, expected: {
  taskId: string;
  nodeId: string;
  phase: Phase;
  revision: number;
  evidencePaths: string[];
  /** Current immutable decision facts recorded in task.yaml. */
  decisionFactPaths: string[];
}): Handoff {
  let handoff: Handoff;
  try {
    handoff = HandoffSchema.parse(parse(content));
  } catch (error) {
    throw new Error(formatSchemaDiagnostics({
      title: '交接包',
      error,
      aliases: {
        decisionId: '不能使用 decisionId；决策项请使用 id。',
        acceptanceId: '不能使用 acceptanceId；验收项请使用 id。',
      },
      itemLabel: '交接内容',
    }), { cause: error });
  }
  if (handoff.taskId !== expected.taskId || handoff.nodeId !== expected.nodeId || handoff.phase !== expected.phase || handoff.revision !== expected.revision) {
    throw new Error('交接包与当前节点身份或 revision 不一致');
  }
  const permitted = new Set(expected.evidencePaths);
  for (const evidence of allEvidence(handoff)) {
    if (!permitted.has(evidence.path)) {
      throw new Error(`交接包引用了不允许的证据：${evidence.path}`);
    }
  }
  validateDecisionReferences(handoff, expected.decisionFactPaths);
  return handoff;
}

/**
 * A handoff is a summary, never a second decision register. Every decision it
 * carries therefore points at the immutable decision fact that AIW recorded
 * after a human choice. This prevents a free-form sentence from being treated
 * as a confirmed decision by a downstream node.
 */
function validateDecisionReferences(handoff: Handoff, decisionFactPaths: string[]): void {
  const currentFacts = new Map<string, string>();
  for (const path of decisionFactPaths) {
    const match = /^decisions\/(DEC-[A-Z0-9-]+)\/r\d+\.yaml$/.exec(path);
    if (match !== null) currentFacts.set(match[1], path);
  }
  for (const decision of handoff.decisions) {
    const factPath = currentFacts.get(decision.id);
    if (factPath === undefined) {
      throw new Error(`交接包决策 ${decision.id} 未关联当前已登记的决策事实`);
    }
    if (!decision.evidence.some((evidence) => evidence.path === factPath)) {
      throw new Error(`交接包决策 ${decision.id} 必须引用当前决策事实：${factPath}`);
    }
  }
}

/**
 * Handoff facts are summaries of the formal clarification fact register. The
 * caller supplies the current register IDs once all sibling artifacts have
 * been validated, because clarify emits that register in the same run.
 */
export function validateHandoffFactReferences(handoff: Handoff, factIds: string[]): void {
  const formalFacts = new Set(factIds);
  for (const fact of handoff.facts) {
    if (!formalFacts.has(fact.id)) {
      throw new Error(`交接包事实 ${fact.id} 未关联当前正式事实登记`);
    }
  }
}

function allEvidence(handoff: Handoff): Array<z.infer<typeof EvidenceSchema>> {
  return [
    ...handoff.facts.flatMap((fact) => fact.evidence),
    ...handoff.decisions.flatMap((decision) => decision.evidence),
    ...handoff.acceptance.flatMap((acceptance) => acceptance.evidence),
    ...handoff.verification.flatMap((verification) => verification.evidence),
  ];
}
