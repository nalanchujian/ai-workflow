import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { formatSchemaDiagnostics } from '../../src/domain/schema-diagnostics.js';

describe('schema diagnostics', () => {
  const schema = z.object({ units: z.array(z.object({ title: z.string(), steps: z.array(z.string()) })) });

  it('names nested list items and reports object types without exposing their contents', () => {
    const data = { units: [{ title: '主题', steps: ['第一步', { 'private value': 'secret-content' }] }] };
    const result = schema.safeParse(data);
    if (result.success) throw new Error('fixture must be invalid');
    const message = formatSchemaDiagnostics({ title: '开发计划', error: result.error, data, itemLabel: '开发单元' });
    expect(message).toContain('开发单元第 1 项 · steps 第 2 项');
    expect(message).toContain('应为文本，实际为对象');
    expect(message).toContain('引号');
    expect(message).not.toMatch(/缺少|secret-content|private value/);
  });

  it.each([
    { data: { units: [{ steps: [] }] }, expected: '缺少字段 title' },
    { data: { units: [{ title: null, steps: [] }] }, expected: '应为文本，实际为 null' },
    { data: { units: [{ title: 10, steps: [] }] }, expected: '应为文本，实际为数字' },
    { data: { units: [{ title: '主题', steps: {} }] }, expected: '应为列表，实际为对象' },
  ])('distinguishes missing values from invalid types: $expected', ({ data, expected }) => {
    const result = schema.safeParse(data);
    if (result.success) throw new Error('fixture must be invalid');
    expect(formatSchemaDiagnostics({ title: '开发计划', error: result.error, data, itemLabel: '开发单元' })).toContain(expected);
  });

  it('does not infer a missing value from Zod omitting input in its error', () => {
    const result = z.string().safeParse({ value: 'present' });
    if (result.success) throw new Error('fixture must be invalid');
    const message = formatSchemaDiagnostics({ title: '产物', error: result.error });
    expect(message).toContain('应为文本');
    expect(message).not.toContain('缺少');
  });
});
