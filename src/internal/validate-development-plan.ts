import { readFile } from 'node:fs/promises';

import { validateDevelopmentPlan } from '../services/implementation-work-planner.js';

// Internal, read-only artifact check. No task transition or artifact rewriting.
try {
  const path = process.argv[2];
  if (path === undefined || process.argv.length !== 3) throw new Error('请提供一个开发计划 YAML 文件路径。');
  validateDevelopmentPlan(await readFile(path, 'utf8'));
  process.stdout.write('开发计划结构校验通过\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : '开发计划结构校验失败'}\n`);
  process.exitCode = 1;
}
