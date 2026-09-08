import { stringify } from 'yaml';

export function developmentPlanYaml(quoted = false): string {
  const units = Array.from({ length: 8 }, (_, index) => ({
    name: `development-unit-feature-${index + 1}`,
    title: `功能 ${index + 1}`,
    goal: '完成当前功能',
    requirements: [index === 4 ? '请求使用 granularity: day。' : '保留已有功能'],
    codeScope: [`src/feature-${index + 1}.ts`],
    steps: ['完成实现', index === 7 ? '使用 prefers-color-scheme: dark 切换主题。' : '调整入口'],
    dependencies: [],
  }));
  const content = stringify({ schemaVersion: 'aiw.development-plan/v2', units });
  return quoted ? content : content
    .replace('"请求使用 granularity: day。"', '请求使用 granularity: day。')
    .replace('"使用 prefers-color-scheme: dark 切换主题。"', '使用 prefers-color-scheme: dark 切换主题。');
}
