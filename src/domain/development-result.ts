import { validateMarkdownArtifactContract } from './artifact-contracts.js';

const forbiddenClaims = ['测试通过', '验收通过', '验收完成', '交付完成', '生产可用'] as const;

export function validateDevelopmentResult(content: string): void {
  // Use the same heading/section contract that is rendered into the prompt.
  validateMarkdownArtifactContract('development/result.md', content);
  const claim = forbiddenClaims.find((item) => content.includes(item));
  if (claim !== undefined) {
    throw new Error(`开发结果不能声称“${claim}”；当前流程只负责代码开发`);
  }
}
