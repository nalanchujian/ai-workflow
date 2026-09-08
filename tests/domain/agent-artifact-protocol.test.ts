import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parse } from 'yaml';

import {
  agentArtifactProtocolIds,
  renderAgentArtifactProtocol,
  renderAgentArtifactProtocolDescriptor,
} from '../../src/services/agent-artifact-protocol.js';

describe('Agent artifact protocol', () => {
  it('renders every registered contract from its schema and a schema-valid YAML example', () => {
    expect(agentArtifactProtocolIds).toEqual([
      'api-analysis',
      'design-assets',
      'fact-register',
      'decision-register',
      'development-plan',
    ]);

    for (const id of agentArtifactProtocolIds) {
      const rendered = renderAgentArtifactProtocol(id, {
        evidencePath: 'sources/requirements/r1/snapshot.md',
      });
      expect(rendered).toContain(`<artifact-protocol id="${id}"`);
      expect(rendered).toContain('字段结构（由 Zod Schema 生成）');
      expect(rendered).toContain('YAML 示例（已通过同一 Schema 校验）');
      const yaml = /```yaml\n([\s\S]*?)\n```/.exec(rendered)?.[1];
      expect(yaml).toBeDefined();
      expect(parse(yaml!).schemaVersion).toMatch(/^aiw\./);
      expect(rendered).toContain('冒号 + 空格');
    }
  });

  it('quotes text examples so punctuation cannot turn strings into YAML objects', () => {
    const schema = z.object({ steps: z.array(z.string()) });
    const example = { steps: ['granularity: day', 'prefers-color-scheme: dark', '含 "引号" 和换行\n的说明'] };
    const rendered = renderAgentArtifactProtocolDescriptor({ id: 'text', title: '文本', schema, example, rules: [] });
    const yaml = /```yaml\n([\s\S]*?)\n```/.exec(rendered)![1]!;
    expect(schema.parse(parse(yaml))).toEqual(example);
    expect(yaml).toContain('"granularity: day"');
  });

  it('derives compact field and enum guidance from Zod instead of handwritten prompt text', () => {
    const rendered = renderAgentArtifactProtocolDescriptor({
      id: 'sample',
      title: '示例协议',
      schema: z.object({
        schemaVersion: z.literal('sample/v1'),
        status: z.enum(['passed', 'failed']),
        note: z.string().min(3).optional(),
      }).strict(),
      example: { schemaVersion: 'sample/v1', status: 'passed' },
      rules: ['状态必须来自真实结果。'],
    });

    expect(rendered).toContain('- schemaVersion: literal "sample/v1"');
    expect(rendered).toContain('- status: enum "passed" | "failed"');
    expect(rendered).toContain('- note?: string');
    expect(rendered).toContain('状态必须来自真实结果。');
  });

  it('refuses to render an example that has drifted from its Zod schema', () => {
    expect(() => renderAgentArtifactProtocolDescriptor({
      id: 'broken',
      title: '错误协议',
      schema: z.object({ schemaVersion: z.literal('sample/v1'), required: z.string() }).strict(),
      example: { schemaVersion: 'sample/v1', stale: true },
      rules: [],
    })).toThrow();
  });
});
