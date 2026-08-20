import { z } from 'zod';

import { ImpactGraphReferenceSchema } from './impact-graph.js';

const sha256Pattern = /^[a-f0-9]{64}$/;
const taskIdPattern = /^[a-z][a-z0-9-]{1,63}$/;
const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

export const PhaseSchema = z.enum([
  'intake',
  'clarify',
  'solution',
  'plan',
  'implement',
]);

export const NodeStatusSchema = z.enum([
  'pending',
  'blocked',
  'ready',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'invalidated',
  'cancelled',
  'superseded',
]);

export const TaskStatusSchema = z.enum(['active', 'partially_blocked', 'blocked', 'completed', 'cancelled']);
export const DeliveryStatusSchema = z.enum(['not_assessed', 'ready', 'not_ready', 'risk_accepted']);
export const ExternalResolutionImpactSchema = z.enum(['execution-only', 'replan']);
export const WorkflowPathIdSchema = z.enum(['quick', 'standard']);

/**
 * The selected delivery path is a task fact, not an invocation flag.  It is
 * chosen after clarification, therefore the choice is tied to the current
 * assessment bytes that justified it.
 */
export const WorkflowPathSelectionSchema = z.object({
  id: WorkflowPathIdSchema,
  assessmentPath: z.string().regex(relativePathPattern, '工作方式评估必须是任务根目录内的相对路径'),
  assessmentSha256: z.string().regex(sha256Pattern, '工作方式评估必须记录 SHA-256 哈希'),
  policyVersion: z.string().min(1),
  selectedAt: z.string().datetime(),
  selectedBy: z.string().min(1),
}).strict();

export const DecisionResolutionSchema = z.object({
  id: z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效'),
  // A task decision has exactly two pre-delivery outcomes: it is resolved for
  // this scope, or it is waiting for an external condition. Scope changes
  // restart from the source snapshot; delivery risks are recorded only by the
  // delivery-unit close-with-risk fact.
  status: z.enum(['resolved', 'waiting_external']),
  optionId: z.string().min(1),
  actor: z.string().min(1),
  at: z.string().datetime(),
  owner: z.string().min(1).optional(),
  unblockCondition: z.string().min(8).optional(),
  note: z.string().min(1).optional(),
  resolutionImpact: ExternalResolutionImpactSchema.optional(),
  inputFactPath: z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径').optional(),
  factPath: z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径'),
}).strict().superRefine((decision, context) => {
  if (decision.resolutionImpact === 'replan' && decision.inputFactPath === undefined) {
    context.addIssue({ code: 'custom', path: ['inputFactPath'], message: '重新规划必须记录新增事实' });
  }
  if (decision.resolutionImpact === 'execution-only' && decision.inputFactPath !== undefined) {
    context.addIssue({ code: 'custom', path: ['inputFactPath'], message: '仅恢复执行不得附带新增方案事实' });
  }
  if ((decision.resolutionImpact !== undefined || decision.inputFactPath !== undefined) && decision.status !== 'resolved') {
    context.addIssue({ code: 'custom', path: ['resolutionImpact'], message: '外部等待解除信息仅允许用于已解除的决策' });
  }
});

export const RegistrySourceSchema = z.object({
  url: z.string().min(1),
  revision: z.string().min(1),
});

export const MethodSourceSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  version: z.string().min(1),
  revision: z.string().min(1),
  sha256: z.string().regex(sha256Pattern, '必须是 SHA-256 哈希'),
});

export const SkillLockSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  registrySource: RegistrySourceSchema,
  sha256: z.string().regex(sha256Pattern, '必须是 SHA-256 哈希'),
  methodSources: z.array(MethodSourceSchema),
});

export const WorkflowProfileLockSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  registrySource: RegistrySourceSchema,
  sha256: z.string().regex(sha256Pattern, '必须是 SHA-256 哈希'),
});

export const OutputRecordSchema = z.object({
  path: z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径'),
  sha256: z.string().regex(sha256Pattern, '必须是 SHA-256 哈希'),
});

export const SourceKindSchema = z.enum(['local-file', 'public-url', 'connected-document']);

export const SourceReferenceSchema = z.object({
  kind: SourceKindSchema,
  origin: z.string().min(1),
  externalId: z.string().min(1).optional(),
  resolvedExternalId: z.string().min(1).optional(),
  section: z.string().min(1).optional(),
  sectionStartBlockId: z.string().min(1).optional(),
  sectionEndBlockId: z.string().min(1).optional(),
  revision: z.number().int().positive(),
  snapshotPath: z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径'),
  metaPath: z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径'),
  contentSha256: z.string().regex(sha256Pattern, '必须是 SHA-256 哈希'),
});

export const TaskNodeSchema = z.object({
  title: z.string().min(1),
  phase: PhaseSchema,
  dependsOn: z.array(z.string().min(1)),
  skill: SkillLockSchema.optional(),
  requiresApproval: z.boolean(),
  status: NodeStatusSchema,
  /** Whether this node has a current result. Re-runs replace it in place. */
  hasResult: z.boolean().default(false),
  outputs: z.array(z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径')),
  contextPath: z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径').optional(),
  /** Generated delivery units belong to the current plan. */
  generatedFromPlan: z.boolean().optional(),
  workUnitId: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, '工作单元 ID 格式无效').optional(),
  verificationCommands: z.array(z.string().min(1)).default([]),
  acceptanceRefs: z.array(z.string().regex(/^AC-\d{2,}$/, '验收项 ID 格式无效')).default([]),
  decisionRefs: z.array(z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效')).default([]),
  blockedByDecisionIds: z.array(z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效')).optional(),
}).strict();

export const TaskEventSchema = z.object({
  type: z.enum([
    'evaluate',
    'start',
    'succeed',
    'approve',
    'fail',
    'cancel',
    'invalidate',
    'materialize_implementation',
    'materialize_impact_graph',
    'migrate_handoff',
    'supersede',
    'choose_decision',
    'defer_decision',
    'resolve_decision',
    'close_with_risk',
    'select_workflow_path',
  ]),
  nodeId: z.string().min(1).optional(),
  decisionId: z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效').optional(),
  at: z.string().datetime(),
  note: z.string().optional(),
  reason: z.string().optional(),
  actor: z.string().optional(),
  runId: z.string().optional(),
  outputs: z.array(OutputRecordSchema).optional(),
  evidencePath: z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径').optional(),
});

const TaskBaseSchema = z.object({
  schemaVersion: z.literal('aiw.task/v2'),
  id: z.string().regex(taskIdPattern),
  title: z.string().min(1),
  repository: z.string().min(1),
  status: TaskStatusSchema,
  deliveryStatus: DeliveryStatusSchema,
  skillProfile: WorkflowProfileLockSchema,
  sources: z.record(z.string().min(1), SourceReferenceSchema),
  impactGraph: ImpactGraphReferenceSchema.optional(),
  workflowPath: WorkflowPathSelectionSchema.optional(),
  nodes: z.record(z.string().min(1), TaskNodeSchema),
  approvalRefs: z.array(z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径')),
  decisions: z.array(DecisionResolutionSchema),
  events: z.array(TaskEventSchema),
});

export const TaskSchema = TaskBaseSchema.superRefine((task, context) => {
  const nodeIds = new Set(Object.keys(task.nodes));

  for (const [nodeId, node] of Object.entries(task.nodes)) {
    if (nodeId === 'intake' && node.skill !== undefined) {
      context.addIssue({ code: 'custom', path: ['nodes', nodeId, 'skill'], message: 'intake 节点不得锁定技能' });
    }

    if (nodeId !== 'intake' && node.skill === undefined) {
      context.addIssue({ code: 'custom', path: ['nodes', nodeId, 'skill'], message: '可执行节点必须锁定技能' });
    }

    if (node.phase === 'implement' && node.generatedFromPlan === true && node.acceptanceRefs.length === 0) {
      context.addIssue({ code: 'custom', path: ['nodes', nodeId, 'acceptanceRefs'], message: '交付单元必须声明至少一个验收项' });
    }
    if (node.phase === 'implement' && node.generatedFromPlan === true && node.workUnitId === undefined) {
      context.addIssue({ code: 'custom', path: ['nodes', nodeId, 'workUnitId'], message: '交付单元必须声明工作单元 ID' });
    }
    if (node.phase === 'implement' && node.generatedFromPlan === true && node.verificationCommands.length === 0) {
      context.addIssue({ code: 'custom', path: ['nodes', nodeId, 'verificationCommands'], message: '交付单元必须声明至少一条由 AIW 执行的验证命令' });
    }
    if (node.blockedByDecisionIds?.some((id) => !node.decisionRefs.includes(id))) {
      context.addIssue({ code: 'custom', path: ['nodes', nodeId, 'decisionRefs'], message: 'blockedByDecisionIds 中的决策必须同时出现在 decisionRefs' });
    }

    for (const dependency of node.dependsOn) {
      if (!nodeIds.has(dependency)) {
        context.addIssue({ code: 'custom', path: ['nodes', nodeId, 'dependsOn'], message: `未知依赖节点：${dependency}` });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      context.addIssue({ code: 'custom', path: ['nodes', nodeId, 'dependsOn'], message: '任务依赖图存在 cycle' });
      return;
    }

    if (visited.has(nodeId)) {
      return;
    }

    visiting.add(nodeId);
    for (const dependency of task.nodes[nodeId]?.dependsOn ?? []) {
      if (nodeIds.has(dependency)) {
        visit(dependency);
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };

  for (const nodeId of nodeIds) {
    visit(nodeId);
  }
});

export type Phase = z.infer<typeof PhaseSchema>;
export type NodeStatus = z.infer<typeof NodeStatusSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;
export type ExternalResolutionImpact = z.infer<typeof ExternalResolutionImpactSchema>;
export type WorkflowPathId = z.infer<typeof WorkflowPathIdSchema>;
export type WorkflowPathSelection = z.infer<typeof WorkflowPathSelectionSchema>;
export type DecisionResolution = z.infer<typeof DecisionResolutionSchema>;

/** Returns only decision facts explicitly registered in the immutable task record. */
export function registeredDecisionFactPaths(task: Pick<Task, 'decisions'>): string[] {
  return [...new Set(task.decisions.flatMap((decision) => [
    decision.factPath,
    ...(decision.inputFactPath === undefined ? [] : [decision.inputFactPath]),
  ]))];
}
export type SkillLock = z.infer<typeof SkillLockSchema>;
export type OutputRecord = z.infer<typeof OutputRecordSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
export type SourceReference = z.infer<typeof SourceReferenceSchema>;
export type TaskNode = z.infer<typeof TaskNodeSchema>;
export type Task = z.infer<typeof TaskSchema>;
