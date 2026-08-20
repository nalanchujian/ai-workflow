import { stringify } from 'yaml';
import { z } from 'zod';

import { AcceptanceCatalogSchema } from '../domain/acceptance-catalog.js';
import { AcceptanceIntentSchema } from '../domain/acceptance-intent.js';
import type { AcceptanceEvidenceType } from '../domain/acceptance-evidence.js';
import { DecisionRegisterSchema } from '../domain/decision-register.js';
import { FactRegisterSchema } from '../domain/fact-register.js';
import { HandoffSchema } from '../domain/handoff.js';
import type { Phase } from '../domain/task.js';
import { WorkBreakdownSchema } from '../domain/work-breakdown.js';

export const agentArtifactProtocolIds = [
  'fact-register',
  'acceptance-catalog',
  'decision-register',
  'work-breakdown',
  'acceptance-intent',
  'handoff',
] as const;

export type AgentArtifactProtocolId = typeof agentArtifactProtocolIds[number];

export type AgentArtifactProtocolContext = {
  taskId: string;
  nodeId: string;
  phase: Phase;
  evidencePath: string;
  testProfile: string;
  testEvidenceType: AcceptanceEvidenceType;
};

export type AgentArtifactProtocolDescriptor = {
  id: string;
  title: string;
  schema: z.ZodType;
  example: unknown;
  rules: string[];
};

const defaultContext: AgentArtifactProtocolContext = {
  taskId: 'task-example',
  nodeId: 'clarify',
  phase: 'clarify',
  evidencePath: 'sources/requirements/r1/snapshot.md',
  testProfile: 'vitest',
  testEvidenceType: 'unit',
};

export function renderAgentArtifactProtocol(
  id: AgentArtifactProtocolId,
  context: Partial<AgentArtifactProtocolContext> = {},
): string {
  const resolved = { ...defaultContext, ...context };
  return renderAgentArtifactProtocolDescriptor(descriptorFor(id, resolved));
}

export function renderAgentArtifactProtocolDescriptor(descriptor: AgentArtifactProtocolDescriptor): string {
  const example = descriptor.schema.parse(descriptor.example);
  const jsonSchema = z.toJSONSchema(descriptor.schema) as JsonSchema;
  const fields = renderObjectFields(jsonSchema);
  return [
    `<artifact-protocol id="${escapeAttribute(descriptor.id)}" title="${escapeAttribute(descriptor.title)}">`,
    '字段结构（由 Zod Schema 生成）：',
    fields,
    'YAML 示例（已通过同一 Schema 校验）：',
    '```yaml',
    stringify(example, { lineWidth: 0 }).trimEnd(),
    '```',
    ...(descriptor.rules.length === 0 ? [] : ['语义规则：', ...descriptor.rules.map((rule) => `- ${rule}`)]),
    '</artifact-protocol>',
  ].join('\n');
}

function descriptorFor(id: AgentArtifactProtocolId, context: AgentArtifactProtocolContext): AgentArtifactProtocolDescriptor {
  switch (id) {
    case 'fact-register':
      return {
        id,
        title: '正式事实登记',
        schema: FactRegisterSchema,
        example: {
          schemaVersion: 'aiw.fact-register/v1',
          items: [{
            id: 'FACT-METRICS-01',
            kind: 'confirmed',
            statement: '主列表允许用户配置可见指标并保存当前选择。',
            confidence: 'high',
            evidence: [{ sourceId: 'requirements', path: context.evidencePath, locator: '主表格 / Custom metrics' }],
          }],
        },
        rules: [
          'confirmed 只能使用 high；推断、待确认或外部依赖不能使用 high。',
          '每项事实必须引用当前任务已固化的来源证据；不得把推断写成已确认事实。',
          '每个非 confirmed 事实必须由至少一个决策项显式处理。',
        ],
      };
    case 'acceptance-catalog':
      return {
        id,
        title: '验收清单',
        schema: AcceptanceCatalogSchema,
        example: {
          schemaVersion: 'aiw.acceptance-catalog/v2',
          items: [{
            id: 'AC-01',
            title: '列表指标配置',
            description: '用户可以切换并保存列表展示指标。',
            factRefs: ['FACT-METRICS-01'],
            evidenceType: 'component',
          }],
        },
        rules: [
          '每个 AC 必须有正式事实依据，并与验收说明中的编号一一对应。',
          'UI 交互使用 component 或 browser；API 契约使用 contract 或 integration；只有纯逻辑使用 unit。',
        ],
      };
    case 'decision-register':
      return {
        id,
        title: '待确认决策登记',
        schema: DecisionRegisterSchema,
        example: {
          schemaVersion: 'aiw.decision-register/v1',
          items: [{
            id: 'DEC-METRICS-01',
            title: '指标配置保存规则',
            detail: {
              question: '指标选择应保存到浏览器还是服务端？',
              background: '当前需求没有说明保存位置，仓库也不存在统一契约。',
              impact: '未确认会影响跨设备一致性和验收边界。',
            },
            type: 'technical-contract',
            factRefs: ['FACT-METRICS-01'],
            affects: { acceptanceRefs: ['AC-01'], workUnits: ['list-custom-metrics'] },
            options: [
              { id: 'local-storage', title: '保存到浏览器', tradeoffs: '实现较快，但设置不能跨设备同步。' },
              { id: 'server-storage', title: '保存到服务端', tradeoffs: '支持跨设备同步，但依赖正式接口契约。' },
            ],
            recommendation: { optionId: 'local-storage', rationale: '当前没有服务端契约，先隔离持久化边界更可靠。' },
          }],
        },
        rules: [
          '一次人工选择只解决一个独立业务结论；每个决策项必须且只能关联一个 AC。',
          '只提供一至两个“本期继续”方案；等待外部条件由 task review 单独记录。',
          '推荐方案必须引用已声明选项，不能替代人工选择。',
        ],
      };
    case 'work-breakdown':
      return {
        id,
        title: '实施工作单元声明',
        schema: WorkBreakdownSchema,
        example: {
          schemaVersion: 'aiw.work-breakdown/v2',
          units: [{
            id: 'list-custom-metrics',
            title: '主列表指标配置',
            goal: '完成指标配置、持久化和展示联动。',
            acceptanceRefs: ['AC-01'],
            factRefs: ['FACT-METRICS-01'],
            decisionRefs: ['DEC-METRICS-01'],
            steps: ['实现指标配置交互', '补充交互验证'],
            verification: [{ profile: context.testProfile, targets: ['tests/list.spec.ts'], evidenceType: context.testEvidenceType, acceptanceRefs: ['AC-01'] }],
            blockedBy: [],
            dependsOn: [],
          }],
          acceptanceCoverage: [{ acceptanceId: 'AC-01', disposition: 'implement', workUnitIds: ['list-custom-metrics'] }],
        },
        rules: [
          '每个单元必须引用其 AC、正式事实和相关决策，并使用当前上下文提供的测试能力。',
          '每个 AC 必须且只能归属一个交付单元；跨单元验收必须新增集成交付单元。',
          'waiting_external 必须关联一个决策和一个被阻塞单元；不得用拆期或豁免代替来源变更。',
          '验证映射的证据类型必须等于对应 AC 的证据类型，且不能自行填写命令字符串。',
        ],
      };
    case 'acceptance-intent':
      return {
        id,
        title: '交付验收意图',
        schema: AcceptanceIntentSchema,
        example: {
          schemaVersion: 'aiw.acceptance-intent/v2',
          items: [{ id: 'AC-01', evidence: [context.evidencePath] }],
        },
        rules: [
          '只声明当前交付单元 acceptanceRefs 中的 AC 及业务证据。',
          '不得填写测试引用、状态、退出码或通过/失败结论；测试结果与最终验收结果只由 AIW 写入。',
        ],
      };
    case 'handoff':
      return {
        id,
        title: '结构化交接包',
        schema: HandoffSchema,
        example: {
          schemaVersion: 'aiw.handoff/v1',
          taskId: context.taskId,
          nodeId: context.nodeId,
          phase: context.phase,
          summary: '本节点已经完成当前范围内的结论与交接。',
          facts: [{ id: 'FACT-METRICS-01', statement: '主列表指标配置范围已经确认。', evidence: [{ path: context.evidencePath }] }],
          decisions: [],
          acceptance: [{ id: 'AC-01', status: 'covered', evidence: [{ path: context.evidencePath }] }],
          changes: [{ path: 'src/example.ts', summary: '实现当前交付单元要求的业务行为。' }],
          verification: [{ command: 'pnpm test', result: 'passed', evidence: [{ path: context.evidencePath }] }],
          openRisks: [{ description: '仍需确认生产环境数据规模。', impact: '可能影响大数据量下的响应时间。' }],
        },
        rules: [
          '事实只能复用正式事实登记中的 FACT-*；决策只能复用 AIW 已确认的 DEC-*。',
          '所有 evidence.path 必须是当前允许引用的正式任务事实，不得引用暂存路径或交接包自身。',
          '没有对应内容时使用空数组，不得增加协议未声明字段。',
        ],
      };
  }
}

type JsonSchema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
};

function renderObjectFields(schema: JsonSchema): string {
  if (schema.properties === undefined) return `- value: ${typeSummary(schema)}`;
  return renderProperties(schema.properties, new Set(schema.required ?? []), 0).join('\n');
}

function renderProperties(properties: Record<string, JsonSchema>, required: Set<string>, depth: number): string[] {
  return Object.entries(properties).flatMap(([name, schema]) => {
    const indent = '  '.repeat(depth);
    const optional = required.has(name) ? '' : '?';
    const line = `${indent}- ${name}${optional}: ${typeSummary(schema)}`;
    const child = objectChild(schema);
    if (child?.properties === undefined) return [line];
    return [line, ...renderProperties(child.properties, new Set(child.required ?? []), depth + 1)];
  });
}

function objectChild(schema: JsonSchema): JsonSchema | undefined {
  if (schema.type === 'object') return schema;
  if (schema.type === 'array' && schema.items?.type === 'object') return schema.items;
  return undefined;
}

function typeSummary(schema: JsonSchema): string {
  if (schema.const !== undefined) return `literal ${JSON.stringify(schema.const)}`;
  if (schema.enum !== undefined) return `enum ${schema.enum.map((item) => JSON.stringify(item)).join(' | ')}`;
  if (schema.anyOf !== undefined) return schema.anyOf.map(typeSummary).join(' | ');
  if (schema.type === 'array') return `array<${schema.items === undefined ? 'unknown' : typeSummary(schema.items)}>`;
  if (schema.type === 'object') return 'object';
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  return schema.type ?? 'unknown';
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
