const contracts: Array<{ matches: (path: string) => boolean; label: string; headings: string[] }> = [
  { matches: (path) => path.endsWith('/design-context.md'), label: '设计上下文', headings: ['设计范围', '页面与状态', '共性规则', '待确认问题'] },
  { matches: (path) => path.endsWith('/solution.md'), label: '技术方案', headings: ['方案结论', '架构与接口影响', '风险与待决事项'] },
  { matches: (path) => path.endsWith('/result.md'), label: '开发结果', headings: ['完成的代码修改', '变更文件', '未解决问题', '已知风险'] },
];

export function validateMarkdownArtifactContract(path: string, content: string): void {
  const contract = contracts.find((candidate) => candidate.matches(path));
  if (contract === undefined) return;
  if (!/^#\s+\S.+$/m.test(content)) {
    throw new Error(`${contract.label}结构不完整：文件开头必须有一级标题，例如「# ${contract.label}」。`);
  }
  const missing = contract.headings.filter((heading) => !new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*$`, 'm').test(content));
  if (missing.length > 0) {
    throw new Error(`${contract.label}结构不完整：缺少章节「${missing.map((heading) => `## ${heading}`).join('」「')}」。`);
  }
}

export function markdownArtifactContractFor(paths: string[]): string {
  const applicable = paths.flatMap((path) => {
    const contract = contracts.find((candidate) => candidate.matches(path));
    return contract === undefined ? [] : [`- ${path}：必须包含 ${contract.headings.map((heading) => `「## ${heading}」`).join('、')}`];
  });
  return applicable.length === 0 ? '' : `\n所有 Markdown 产物必须以一级标题（例如「# 需求摘要」）开头；不能只输出二级章节或正文。并使用以下固定章节：\n${applicable.join('\n')}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
