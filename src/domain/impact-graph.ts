import { z } from 'zod';

import { FactKindSchema } from './fact-register.js';

const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

const ImpactFactSchema = z.object({
  id: z.string().regex(/^FACT-[A-Z0-9-]+$/),
  kind: FactKindSchema,
  sourceIds: z.array(z.string().min(1)).min(1),
  decisionIds: z.array(z.string().regex(/^DEC-[A-Z0-9-]+$/)),
  acceptanceRefs: z.array(z.string().regex(/^AC-\d{2,}$/)),
  workUnitIds: z.array(z.string().min(1)),
  deliveryNodeIds: z.array(z.string().min(1)),
}).strict();

const ImpactDecisionSchema = z.object({
  id: z.string().regex(/^DEC-[A-Z0-9-]+$/),
  factRefs: z.array(z.string().regex(/^FACT-[A-Z0-9-]+$/)).min(1),
  acceptanceRefs: z.array(z.string().regex(/^AC-\d{2,}$/)).length(1),
  workUnitIds: z.array(z.string().min(1)).min(1),
  deliveryNodeIds: z.array(z.string().min(1)),
}).strict();

const ImpactAcceptanceSchema = z.object({
  id: z.string().regex(/^AC-\d{2,}$/),
  factRefs: z.array(z.string().regex(/^FACT-[A-Z0-9-]+$/)).min(1),
  decisionIds: z.array(z.string().regex(/^DEC-[A-Z0-9-]+$/)),
  workUnitId: z.string().min(1).optional(),
  deliveryNodeId: z.string().min(1).optional(),
}).strict();

const ImpactUnitSchema = z.object({
  id: z.string().min(1),
  deliveryNodeId: z.string().min(1),
  acceptanceRefs: z.array(z.string().regex(/^AC-\d{2,}$/)).min(1),
  factRefs: z.array(z.string().regex(/^FACT-[A-Z0-9-]+$/)).min(1),
  decisionIds: z.array(z.string().regex(/^DEC-[A-Z0-9-]+$/)),
  dependsOn: z.array(z.string().min(1)),
  verificationCommands: z.array(z.string().min(1)).min(1),
}).strict();

/** A deterministic, versioned view of source → fact → decision → AC → unit. */
export const ImpactGraphSchema = z.object({
  schemaVersion: z.literal('aiw.impact-graph/v1'),
  taskId: z.string().min(1),
  clarifyRevision: z.number().int().positive(),
  planRevision: z.number().int().positive(),
  facts: z.array(ImpactFactSchema).min(1),
  decisions: z.array(ImpactDecisionSchema),
  acceptance: z.array(ImpactAcceptanceSchema).min(1),
  units: z.array(ImpactUnitSchema).min(1),
}).strict();

export const ImpactGraphReferenceSchema = z.object({
  path: z.string().regex(relativePathPattern, '影响图路径必须是任务目录内的相对路径'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, '影响图哈希必须是 SHA-256'),
  clarifyRevision: z.number().int().positive(),
  planRevision: z.number().int().positive(),
}).strict();

export type ImpactGraph = z.infer<typeof ImpactGraphSchema>;
export type ImpactGraphReference = z.infer<typeof ImpactGraphReferenceSchema>;
