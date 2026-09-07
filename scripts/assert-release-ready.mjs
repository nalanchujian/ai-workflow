import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const changed = changedPaths();
if (changed.length !== 1 || changed[0] !== 'package.json') {
  throw new Error(`仅允许 package.json 作为发布版本变更：${changed.join(', ') || '无'}`);
}

let changedPackage = false;
try {
  execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'package.json'], { stdio: 'ignore' });
} catch (error) {
  if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) {
    changedPackage = true;
  } else {
    throw error;
  }
}
if (!changedPackage) {
  throw new Error('package.json 未包含待发布的版本变更');
}

assertDefaultSkillSourceVersion();

function changedPaths() {
  return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3));
}

function assertDefaultSkillSourceVersion() {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const workflow = readFileSync('src/services/default-workflow.ts', 'utf8');
  const skillTag = workflow.match(/ref:\s*'v([^']+)'/)?.[1];

  if (!skillTag) {
    throw new Error('无法读取官方技能包版本：src/services/default-workflow.ts');
  }
  if (skillTag !== packageJson.version) {
    throw new Error(`待发布 AIW 版本 ${packageJson.version} 与默认技能包标签 v${skillTag} 不一致`);
  }
}
