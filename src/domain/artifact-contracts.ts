const contracts: Array<{ matches: (path: string) => boolean; label: string; headings: string[] }> = [
  { matches: (path) => path.endsWith('/brief.md'), label: '需求摘要', headings: ['目标与范围', '来源依据'] },
  { matches: (path) => path.endsWith('/questions.md'), label: '需求疑问', headings: ['开放问题', '影响'] },
  { matches: (path) => path.endsWith('/acceptance.md'), label: '验收标准', headings: ['验收项'] },
  { matches: (path) => path.endsWith('/solution.md'), label: '技术方案', headings: ['方案结论', '架构与接口影响', '风险与待决事项'] },
  { matches: (path) => path.endsWith('/implementation-plan.md'), label: '实施计划', headings: ['实施单元', '范围与边界', '验证方式'] },
  { matches: (path) => /\/work-units\/r\d+\/delivery-.+\.md$/.test(path), label: '交付单元上下文', headings: ['交付目标', '验收项', '交付步骤', '工程验证与验收测试'] },
  { matches: (path) => path.endsWith('/delivery.md'), label: '交付报告', headings: ['实际变更', '工程验证', '测试命令', '测试结果', '逐项验收', '未完成事项与风险'] },
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
