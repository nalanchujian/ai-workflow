import { parse } from 'yaml';
import { z } from 'zod';

import { PhaseSchema, type Phase, type TaskNode } from './task.js';
import { formatSchemaDiagnostics } from './schema-diagnostics.js';

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
    id: z.string().regex(/^FACT-\d+$/),
    statement: z.string().min(8),
    evidence: z.array(EvidenceSchema).min(1),
  }).strict()).min(1),
  decisions: z.array(z.object({
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
}): Handoff {
  let handoff: Handoff;
  try {
    handoff = HandoffSchema.parse(parse(content));
  } catch (error) {
    throw new Error(formatSchemaDiagnostics({
      title: '交接包',
      error,
      aliases: {
        decisionId: '不能使用 decisionId；决策项只允许 statement 和 evidence。',
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
  return handoff;
}

function allEvidence(handoff: Handoff): Array<z.infer<typeof EvidenceSchema>> {
  return [
    ...handoff.facts.flatMap((fact) => fact.evidence),
    ...handoff.decisions.flatMap((decision) => decision.evidence),
    ...handoff.acceptance.flatMap((acceptance) => acceptance.evidence),
    ...handoff.verification.flatMap((verification) => verification.evidence),
  ];
}
