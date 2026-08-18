import type { AcceptanceResults } from './acceptance-results.js';
import type { TestResults } from './test-results.js';

const commandPattern = /`[^`\n]*\b(?:npm|pnpm|yarn|bun|npx|node|vitest|jest|playwright|cypress|eslint|prettier|git)\b[^`\n]*`/i;
const testIdPattern = /\bTEST-[A-Z0-9-]+\b/;

/**
 * Codex only declares the tests that should substantiate this delivery. AIW
 * executes them after Codex exits, so an Agent report must never pretend to
 * own their exit codes or final outcomes.
 */
export function hasTestPlanEvidence(content: string): boolean {
  const hasCommand = commandPattern.test(content);
  const hasTestId = testIdPattern.test(content);
  const hasNamedSection = /#{1,6}\s*(?:测试计划|test plan)/i.test(content);
  return hasCommand && hasTestId && hasNamedSection;
}

/**
 * A passing AC is only credible when it points to a platform-owned test
 * record from this delivery revision, and that record says the command
 * actually exited 0. The Markdown is checked only for the declared test ID
 * and command; it is not a second authority for execution outcomes.
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
      if (!input.report.includes(test.id) || !input.report.includes(test.command)) {
        throw new Error(`交付报告必须在测试计划中记录验收项 ${item.id} 引用的测试 ${testId} 与命令`);
      }
    }
  }
}

export function testEvidencePaths(results: TestResults): string[] {
  return results.items.map((item) => item.evidencePath);
}
