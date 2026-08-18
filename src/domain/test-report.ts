import type { AcceptanceResults } from './acceptance-results.js';
import type { TestResults } from './test-results.js';

const commandPattern = /`[^`\n]*\b(?:npm|pnpm|yarn|bun|npx|node|vitest|jest|playwright|cypress|eslint|prettier|git)\b[^`\n]*`/i;
const outcomePattern = /(?:退出码\s*`?\d+`?|exit(?:\s+code)?\s*`?\d+`?|\b(?:passed|failed|skipped|blocked)\b|(?:通过|失败|未执行|阻塞))/i;

/**
 * A test report is credible only when it records an executable command and
 * its outcome. The preferred form uses explicit sections; a structured
 * Markdown table is equally traceable.
 */
export function hasTestExecutionEvidence(content: string): boolean {
  const hasCommand = commandPattern.test(content);
  const hasOutcome = outcomePattern.test(content);
  if (!hasCommand || !hasOutcome) return false;

  const hasNamedSections = /#{1,6}\s*(?:测试命令|test commands?)/i.test(content)
    && /#{1,6}\s*(?:测试结果|test results?)/i.test(content);
  if (hasNamedSections) return true;

  return content.split('\n').some((line) => line.trimStart().startsWith('|')
    && commandPattern.test(line)
    && outcomePattern.test(line));
}

/**
 * A passing AC is only credible when it points to a test record from this
 * delivery revision, and that record says the command actually exited 0.
 * The Markdown is checked as well so reviewers see the same evidence rather
 * than a YAML-only assertion hidden from the delivery report.
 */
export function validateAcceptanceTestEvidence(input: {
  report: string;
  acceptance: AcceptanceResults;
  tests: TestResults;
}): void {
  const tests = new Map(input.tests.items.map((item) => [item.id, item]));
  for (const item of input.acceptance.items) {
    if (item.status !== 'passed') continue;
    for (const testId of item.testResultRefs) {
      const test = tests.get(testId);
      if (test === undefined) {
        throw new Error(`验收项 ${item.id} 引用了不存在的测试记录：${testId}`);
      }
      if (test.status !== 'passed' || test.exitCode !== 0) {
        throw new Error(`验收项 ${item.id} 只能引用实际通过且退出码为 0 的测试记录：${testId}`);
      }
      if (!input.report.includes(test.id) || !input.report.includes(test.command) || !hasExitCode(input.report, test.exitCode)) {
        throw new Error(`交付报告必须记录验收项 ${item.id} 引用的测试 ${testId}、命令及退出码`);
      }
    }
  }
}

export function testEvidencePaths(results: TestResults): string[] {
  return results.items.map((item) => item.evidencePath);
}

function hasExitCode(content: string, exitCode: number): boolean {
  return new RegExp(`(?:退出码|exit(?:\\s+code)?)\\s*[：:]?\\s*` + '`?' + `${exitCode}` + '`?', 'i').test(content);
}
