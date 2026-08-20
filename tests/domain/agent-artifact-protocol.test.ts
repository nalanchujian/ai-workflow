import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  agentArtifactProtocolIds,
  renderAgentArtifactProtocol,
  renderAgentArtifactProtocolDescriptor,
} from '../../src/services/agent-artifact-protocol.js';

describe('Agent artifact protocol', () => {
  it('renders every registered contract from its schema and a schema-valid YAML example', () => {
    expect(agentArtifactProtocolIds).toEqual([
      'fact-register',
      'acceptance-catalog',
      'decision-register',
      'work-breakdown',
      'acceptance-intent',
      'handoff',
    ]);

    for (const id of agentArtifactProtocolIds) {
      const rendered = renderAgentArtifactProtocol(id, {
        taskId: 'refund-123',
        nodeId: 'clarify',
        phase: 'clarify',
        evidencePath: 'sources/requirements/r1/snapshot.md',
        testProfile: 'playwright',
        testEvidenceType: 'browser',
      });
      expect(rendered).toContain(`<artifact-protocol id="${id}"`);
      expect(rendered).toContain('字段结构（由 Zod Schema 生成）');
      expect(rendered).toContain('YAML 示例（已通过同一 Schema 校验）');
      expect(rendered).toContain('schemaVersion: aiw.');
    }
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
