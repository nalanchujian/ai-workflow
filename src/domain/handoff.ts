import { parse } from 'yaml';
import { z } from 'zod';

import { PhaseSchema, type Phase, type TaskNode } from './task.js';

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

export function outputPathsForNextRun(nodeId: string, node: TaskNode): string[] {
  return [...node.outputs, handoffPath(nodeId, node.revision + 1)];
}

export function outputPathsForCompletedRun(nodeId: string, node: TaskNode): string[] {
  return [...node.outputs, handoffPath(nodeId, node.revision)];
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
    const details = error instanceof z.ZodError
      ? error.issues.map((issue) => `${issue.path.join('.') || '根节点'}：${issue.message}`).join('；')
      : 'YAML 解析失败';
    throw new Error(`交接包格式无效：${details}`, { cause: error });
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
