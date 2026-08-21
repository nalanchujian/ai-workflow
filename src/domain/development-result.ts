const requiredSections = ['完成的代码修改', '变更文件', '未解决问题', '已知风险'] as const;
const forbiddenClaims = ['测试通过', '验收通过', '验收完成', '交付完成', '生产可用'] as const;

export function validateDevelopmentResult(content: string): void {
  if (!/^# 开发结果\s*$/m.test(content)) {
    throw new Error('开发结果必须包含一级标题“开发结果”');
  }
  for (const section of requiredSections) {
    if (!new RegExp(`^## ${section}\\s*$`, 'm').test(content)) {
      throw new Error(`开发结果必须包含“${section}”章节`);
    }
  }
  const claim = forbiddenClaims.find((item) => content.includes(item));
  if (claim !== undefined) {
    throw new Error(`开发结果不能声称“${claim}”；当前流程只负责代码开发`);
  }
}
