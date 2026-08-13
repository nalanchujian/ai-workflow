import { execFileSync } from 'node:child_process';

const changed = changedPaths();
if (changed.length > 0) {
  throw new Error(`发布前工作区必须干净：${changed.join(', ')}`);
}

function changedPaths() {
  return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3));
}
