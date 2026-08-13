import { execFileSync } from 'node:child_process';

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

function changedPaths() {
  return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3));
}
