import { z } from 'zod';

import { TaskInputsSchema } from './task-input.js';

const sha256Pattern = /^[a-f0-9]{64}$/;
const taskIdPattern = /^[a-z][a-z0-9-]{1,63}$/;
const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

export const PhaseSchema = z.enum(['requirement-analysis', 'api-analysis', 'design-slicing', 'solution', 'plan', 'development']);
export const NodeStatusSchema = z.enum([
  'pending', 'ready', 'running', 'awaiting_approval', 'completed', 'failed', 'invalidated', 'cancelled', 'ignored',
]);
export const TaskStatusSchema = z.enum(['active', 'blocked', 'completed', 'cancelled']);
export const SourceKindSchema = z.enum(['local-file', 'public-url', 'connected-document']);

export const RegistrySourceSchema = z.object({
  url: z.string().min(1),
  revision: z.string().min(1),
}).strict();

export const SkillLockSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  registrySource: RegistrySourceSchema,
  sha256: z.string().regex(sha256Pattern, '必须是 SHA-256 哈希'),
}).strict();

export const WorkflowProfileLockSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  registrySource: RegistrySourceSchema,
  sha256: z.string().regex(sha256Pattern, '必须是 SHA-256 哈希'),
}).strict();

export const OutputRecordSchema = z.object({
  path: z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径'),
}).strict();

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
}).strict();

export const TaskNodeSchema = z.object({
  title: z.string().min(1),
  phase: PhaseSchema,
  dependsOn: z.array(z.string().min(1)),
  skills: z.array(SkillLockSchema).min(1),
  requiresApproval: z.boolean(),
  status: NodeStatusSchema,
  hasResult: z.boolean().default(false),
  outputs: z.array(z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径')),
  contextPath: z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径').optional(),
  generatedFromPlan: z.boolean().optional(),
}).strict();

export const TaskEventSchema = z.object({
  type: z.enum(['evaluate', 'start', 'succeed', 'approve', 'fail', 'cancel', 'ignore', 'invalidate', 'materialize_development']),
  nodeId: z.string().min(1).optional(),
  at: z.string().datetime(),
  note: z.string().optional(),
  reason: z.string().optional(),
  actor: z.string().optional(),
  runId: z.string().optional(),
  outputs: z.array(OutputRecordSchema).optional(),
}).strict();

const TaskBaseSchema = z.object({
  schemaVersion: z.literal('aiw.task/v5'),
  stateVersion: z.number().int().nonnegative().default(0),
  id: z.string().regex(taskIdPattern),
  title: z.string().min(1),
  repository: z.string().min(1),
  status: TaskStatusSchema,
  skillProfile: WorkflowProfileLockSchema,
  developmentSkills: z.array(SkillLockSchema).min(1),
  inputs: TaskInputsSchema,
  sources: z.record(z.string().min(1), SourceReferenceSchema),
  nodes: z.record(z.string().min(1), TaskNodeSchema),
  approvalRefs: z.array(z.string().regex(relativePathPattern, '必须是任务根目录内的相对路径')),
  events: z.array(TaskEventSchema),
}).strict();

export const TaskSchema = TaskBaseSchema.superRefine((task, context) => {
  const nodeIds = new Set(Object.keys(task.nodes));
  for (const [nodeId, node] of Object.entries(task.nodes)) {
    if (node.generatedFromPlan === true && (node.phase !== 'development' || node.contextPath === undefined)) {
      context.addIssue({ code: 'custom', path: ['nodes', nodeId], message: '计划生成节点必须是带独立上下文的开发节点' });
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
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependency of task.nodes[nodeId]?.dependsOn ?? []) {
      if (nodeIds.has(dependency)) visit(dependency);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of nodeIds) visit(nodeId);
});

export type Phase = z.infer<typeof PhaseSchema>;
export type NodeStatus = z.infer<typeof NodeStatusSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
export type SourceReference = z.infer<typeof SourceReferenceSchema>;
export type SkillLock = z.infer<typeof SkillLockSchema>;
export type WorkflowProfileLock = z.infer<typeof WorkflowProfileLockSchema>;
export type OutputRecord = z.infer<typeof OutputRecordSchema>;
export type TaskNode = z.infer<typeof TaskNodeSchema>;
export type Task = z.infer<typeof TaskSchema>;
