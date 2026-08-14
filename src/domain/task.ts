import { z } from 'zod';

const sha256Pattern = /^[a-f0-9]{64}$/;
const taskIdPattern = /^[a-z][a-z0-9-]{1,63}$/;
const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

export const PhaseSchema = z.enum([
  'intake',
  'clarify',
  'solution',
  'plan',
  'implement',
  'verify',
  'test',
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

export const DecisionResolutionSchema = z.object({
  id: z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效'),
  revision: z.number().int().positive(),
  status: z.enum(['resolved', 'waiting_external', 'deferred', 'waived']),
  optionId: z.string().min(1),
  actor: z.string().min(1),
  at: z.string().datetime(),
  owner: z.string().min(1).optional(),
  unblockCondition: z.string().min(8).optional(),
  note: z.string().min(1).optional(),
  factPath: z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径'),
}).strict();

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

export const SourceKindSchema = z.enum(['local-file', 'public-url', 'lark-document']);

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
  revision: z.number().int().nonnegative(),
  outputs: z.array(z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径')),
  allowedPaths: z.array(z.string().regex(relativePathPattern, '必须是业务仓库内的相对路径')).optional(),
  contextPath: z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径').optional(),
  generatedFromPlanRevision: z.number().int().positive().optional(),
  blockedByDecisionIds: z.array(z.string().regex(/^DEC-[A-Z0-9-]+$/, '决策 ID 格式无效')).optional(),
});

export const TaskEventSchema = z.object({
  type: z.enum([
    'evaluate',
    'rebind_skill',
    'start',
    'succeed',
    'approve',
    'request_changes',
    'revise',
    'fail',
    'cancel',
    'invalidate',
    'add_subtask',
    'materialize_implementation',
    'migrate_handoff',
    'supersede',
    'choose_decision',
    'defer_decision',
    'resolve_decision',
    'close_with_risk',
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
  previousSkill: SkillLockSchema.optional(),
  nextSkill: SkillLockSchema.optional(),
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
export type DecisionResolution = z.infer<typeof DecisionResolutionSchema>;
export type SkillLock = z.infer<typeof SkillLockSchema>;
export type OutputRecord = z.infer<typeof OutputRecordSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
export type SourceReference = z.infer<typeof SourceReferenceSchema>;
export type TaskNode = z.infer<typeof TaskNodeSchema>;
export type Task = z.infer<typeof TaskSchema>;
