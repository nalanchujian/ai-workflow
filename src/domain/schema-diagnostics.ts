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
      : [humanizeIssue(issue)];
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

function humanizeIssue(issue: z.core.$ZodIssue): string {
  const field = issue.path.at(-1);
  const fieldLabel = typeof field === 'string' ? `字段 ${field}` : '当前值';
  const detail = issue as { input?: unknown; expected?: unknown; values?: unknown[] };
  if (issue.code === 'invalid_type') {
    if (detail.input === undefined) return `缺少${fieldLabel}。`;
    return `${fieldLabel}格式错误${detail.expected === undefined ? '。' : `；应为 ${String(detail.expected)}。`}`;
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
    return `${itemLabel ?? path[0]}第 ${listIndex + 1} 项`;
  }
  if (path.length === 0) return '根节点';
  return path.map((part) => String(part)).join('.');
}
