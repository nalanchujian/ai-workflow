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
