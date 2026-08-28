import { z } from 'zod';

/**
 * Turns a machine-oriented Zod error into an actionable artifact error.
 * Artifact YAML is written by an agent, so the remediation must name the
 * precise field rather than expose a raw parser trace to an end user.
 */
export function formatSchemaDiagnostics(input: {
  title: string;
  error: unknown;
  aliases?: Record<string, string>;
  itemLabel?: string;
  data?: unknown;
}): string {
  if (!(input.error instanceof z.ZodError)) {
    return `${input.title}不是有效 YAML`;
  }
  const aliases = input.aliases ?? {};
  const grouped = new Map<string, string[]>();
  for (const issue of input.error.issues) {
    const location = formatLocation(issue.path, input.itemLabel);
    const messages = issue.code === 'unrecognized_keys'
      ? (issue as { keys: string[] }).keys.map((key) => aliases[key] ?? `不支持字段 ${key}。`)
      : [humanizeIssue(issue, input.data, Object.hasOwn(input, 'data'))];
    grouped.set(location, [...(grouped.get(location) ?? []), ...messages]);
  }
  return [
    `${input.title}格式无效：`,
    ...[...grouped.entries()].flatMap(([location, messages]) => [
      `- ${location}：`,
      ...[...new Set(messages)].map((message) => `  - ${message}`),
    ]),
  ].join('\n');
}

function humanizeIssue(issue: z.core.$ZodIssue, data: unknown, hasData: boolean): string {
  const field = issue.path.at(-1);
  const fieldLabel = typeof field === 'string' ? `字段 ${field}` : '当前值';
  const detail = issue as { input?: unknown; expected?: unknown; values?: unknown[] };
  if (issue.code === 'invalid_type') {
    // Zod normally omits input from issues; omission does not mean the field is missing.
    const known = hasData || Object.hasOwn(detail, 'input');
    const value = hasData ? valueAt(data, issue.path) : detail.input;
    if (known && value === undefined) return `缺少${fieldLabel}。`;
    const expected = typeLabel(String(detail.expected));
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const hint = detail.expected === 'string' && actual === 'object'
      ? '如果这是含“冒号 + 空格”的句子，请给整句加引号或使用 YAML 块文本（|-），不要写成键值对象。'
      : '';
    return `${fieldLabel}应为${expected}${known ? `，实际为${typeLabel(actual)}` : ''}。${hint}`;
  }
  if (issue.code === 'invalid_value') {
    const values = detail.values?.map(String).join('、');
    return `${fieldLabel}取值无效${values === undefined ? '。' : `；只能是 ${values}。`}`;
  }
  return issue.message;
}

function formatLocation(path: PropertyKey[], itemLabel?: string): string {
  const listIndex = typeof path[1] === 'number' ? path[1] : undefined;
  if (listIndex !== undefined && typeof path[0] === 'string') {
    const prefix = `${itemLabel ?? path[0]}第 ${listIndex + 1} 项`;
    return path.length === 2 ? prefix : `${prefix} · ${formatPath(path.slice(2))}`;
  }
  if (path.length === 0) return '根节点';
  return formatPath(path);
}

function formatPath(path: PropertyKey[]): string {
  return path.map((part, index) => typeof part === 'number'
    ? ` 第 ${part + 1} 项`
    : `${index === 0 ? '' : ' · '}${String(part)}`).join('');
}

function valueAt(data: unknown, path: PropertyKey[]): unknown {
  return path.reduce<unknown>((value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key)
    ? (value as Record<PropertyKey, unknown>)[key]
    : undefined, data);
}

function typeLabel(type: string): string {
  return ({ string: '文本', array: '列表', object: '对象', number: '数字', boolean: '布尔值', null: ' null' } as Record<string, string>)[type] ?? type;
}
