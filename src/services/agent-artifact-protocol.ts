import { stringify } from 'yaml';
import { z } from 'zod';

import { DecisionRegisterSchema } from '../domain/decision-register.js';
import { FactRegisterSchema } from '../domain/fact-register.js';
import { DevelopmentPlanSchema } from '../domain/work-breakdown.js';
import { DesignAssetsSchema } from '../domain/design.js';

export const agentArtifactProtocolIds = [
  'design-assets',
  'fact-register',
  'decision-register',
  'development-plan',
] as const;

export type AgentArtifactProtocolId = typeof agentArtifactProtocolIds[number];

export type AgentArtifactProtocolContext = {
  evidencePath: string;
};

export type AgentArtifactProtocolDescriptor = {
  id: string;
  title: string;
  schema: z.ZodType;
  example: unknown;
  rules: string[];
};

const defaultContext: AgentArtifactProtocolContext = {
  evidencePath: 'sources/requirements/current/snapshot.md',
};

export function renderAgentArtifactProtocol(
  id: AgentArtifactProtocolId,
  context: Partial<AgentArtifactProtocolContext> = {},
): string {
  return renderAgentArtifactProtocolDescriptor(descriptorFor(id, { ...defaultContext, ...context }));
}

export function renderAgentArtifactProtocolDescriptor(descriptor: AgentArtifactProtocolDescriptor): string {
  const example = descriptor.schema.parse(descriptor.example);
  const jsonSchema = z.toJSONSchema(descriptor.schema) as JsonSchema;
  return [
    `<artifact-protocol id="${escapeAttribute(descriptor.id)}" title="${escapeAttribute(descriptor.title)}">`,
    '字段结构（由 Zod Schema 生成）：',
    renderObjectFields(jsonSchema),
    'YAML 示例（已通过同一 Schema 校验）：',
    '```yaml',
    stringify(example, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' }).trimEnd(),
    '```',
    'YAML 文本规则：文本值优先用序列化工具生成；手写时给整句加引号，或用 |- 块文本。尤其含“冒号 + 空格”（如 granularity: day）的句子，不能作为未加引号的列表项，否则会被解析成对象。',
    ...(descriptor.rules.length === 0 ? [] : ['语义规则：', ...descriptor.rules.map((rule) => `- ${rule}`)]),
    '</artifact-protocol>',
  ].join('\n');
}

function descriptorFor(id: AgentArtifactProtocolId, context: AgentArtifactProtocolContext): AgentArtifactProtocolDescriptor {
  if (id === 'design-assets') {
    return {
      id,
      title: '设计截图索引',
      schema: DesignAssetsSchema,
      example: {
        schemaVersion: 'aiw.design-assets/v1',
        source: { provider: 'local-images', images: [{ id: 'order-flow', originalName: 'order-flow.png', imagePath: 'sources/design/order-flow.png', mediaType: 'image/png' }] },
        coverage: { sourceImageCount: 1, logicalBlockCount: 1 },
        assets: [{ id: 'order-dialog', sourceImageId: 'order-flow', title: '订单弹窗', kind: 'dialog', imagePath: 'artifacts/design/assets/order-dialog.png', purpose: '订单编辑弹窗布局', developmentUnits: ['development-unit-order-editor'] }],
      },
      rules: [
        'source 必须原样复用任务登记的本地图片清单；sourceImageCount 必须等于输入图片数量。',
        '每项代表一个实际裁切或可直接使用的页面、弹窗、抽屉、浮层或状态图片。',
        '每项必须绑定至少一个开发计划中真实存在的 development-unit-* 名称。',
        '只输出图片索引和裁切图片，不总结设计规则。',
      ],
    };
  }
  if (id === 'fact-register') {
    return {
      id,
      title: '事实登记',
      schema: FactRegisterSchema,
      example: {
        schemaVersion: 'aiw.fact-register/v2',
        facts: [{
          statement: '主列表需要支持调整指标显示顺序。',
          source: { type: 'requirement', path: context.evidencePath, locator: 'Custom metrics' },
        }],
      },
      rules: [
        '只登记能够从需求或仓库直接确认的事实。',
        '不确定内容必须进入决策登记，不得生成 FACT-* 编号。',
      ],
    };
  }
  if (id === 'decision-register') {
    return {
      id,
      title: '决策登记',
      schema: DecisionRegisterSchema,
      example: {
        schemaVersion: 'aiw.decision-register/v2',
        pendingDecisions: [{
          question: 'Selected data 使用哪些导出字段？',
          background: '当前页面存在可见字段配置，但接口契约没有说明字段顺序。',
          impact: '决定本期导出代码如何组装字段参数。',
          options: [
            { title: '使用当前页面可见字段', tradeoffs: '与页面一致，但依赖服务端接受字段列表。' },
            { title: '只使用默认字段', tradeoffs: '实现简单，但本期不支持自定义导出字段。' },
          ],
          recommendation: { option: 0, rationale: '与当前指标配置行为保持一致。' },
        }],
        currentDecisions: [],
        deferredItems: [],
      },
      rules: [
        '每项只解决一个独立业务问题，不得生成 DEC-* 或关联 AC-*。',
        '每项提供一到两个本期方案；延期处理由 task review 写入 deferredItems。',
      ],
    };
  }
  return {
    id,
    title: '开发计划',
    schema: DevelopmentPlanSchema,
    example: {
      schemaVersion: 'aiw.development-plan/v1',
      units: [{
        name: 'development-unit-main-list-metrics',
        title: '主列表指标配置',
        goal: '支持调整并保存主列表指标。',
        requirements: ['支持调整指标顺序', '支持保存用户配置'],
        codeScope: ['src/pages/growth/links/components/custom-metrics/'],
        steps: ['调整指标配置模型', '接入本地持久化'],
        dependencies: [],
      }],
    },
    rules: [
      'name 是开发单元的真实节点名称，必须使用 development-unit-<英文 kebab-case 描述>，例如 development-unit-main-list-export；禁止数字编号和中文名称。',
      'dependencies 只引用同一计划中其他开发单元的 name，不引用 title。',
      '每个开发单元必须自包含，不得引用 FACT-*、DEC-* 或 AC-*。',
      '计划不声明设计图片；设计节点在计划批准后按开发单元名称完成绑定。',
      '只规划代码开发，不包含验证、测试、验收或证据声明。',
    ],
  };
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
    const line = `${'  '.repeat(depth)}- ${name}${required.has(name) ? '' : '?'}: ${typeSummary(schema)}`;
    const child = objectChild(schema);
    return child?.properties === undefined
      ? [line]
      : [line, ...renderProperties(child.properties, new Set(child.required ?? []), depth + 1)];
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
