export interface OutputOptions {
  json: boolean;
  stdout: NodeJS.WriteStream;
}

export interface HumanOutput {
  headline: string;
  details?: Array<{ label: string; value: string }>;
  sections?: Array<{ title: string; lines: string[] }>;
  nextSteps?: string[];
}

export function writeResult(value: unknown, options: OutputOptions): void {
  const output = options.json
    ? JSON.stringify(value)
    : renderFallback(value);

  options.stdout.write(`${output}\n`);
}

export function writeCommandResult(value: unknown, command: Command, stdout: NodeJS.WriteStream, human?: HumanOutput): void {
  if (command.optsWithGlobals().json) {
    writeResult(value, { json: true, stdout });
    return;
  }
  stdout.write(`${human === undefined ? renderFallback(value) : renderHumanOutput(human)}\n`);
}

export function renderHumanOutput(output: HumanOutput): string {
  return [
    output.headline,
    ...(output.details === undefined || output.details.length === 0 ? [] : ['', ...output.details.map((detail) => `${detail.label}：${detail.value}`)]),
    ...(output.sections === undefined || output.sections.length === 0 ? [] : output.sections.flatMap((section) => ['', `${section.title}：`, ...section.lines.map((line) => `- ${line}`)])),
    ...(output.nextSteps === undefined || output.nextSteps.length === 0 ? [] : ['', '下一步：', ...output.nextSteps]),
  ].join('\n');
}

function renderFallback(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length === 0 ? '无结果。' : value.map((item) => `- ${formatValue(item)}`).join('\n');
  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([key]) => key !== 'schemaVersion')
      .map(([key, item]) => `${humanLabel(key)}：${formatValue(item)}`)
      .join('\n');
  }
  return String(value);
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? '无' : value.map(formatValue).join('、');
  if (isRecord(value)) return Object.entries(value).map(([key, item]) => `${humanLabel(key)}=${formatValue(item)}`).join('，');
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value === undefined || value === null) return '无';
  return String(value);
}

function humanLabel(key: string): string {
  const labels: Record<string, string> = {
    taskId: '任务 ID', runId: '运行 ID', status: '状态', revision: '版本', changed: '是否变更', skills: '技能', profiles: '工作流模板',
  };
  return labels[key] ?? key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
import type { Command } from 'commander';
