import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd } from 'node:process';

const manifestPath = resolve(cwd(), 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
  throw new Error('package.json 缺少有效版本号');
}

if (!hasPackageChange()) {
  throw new Error('发布后 package.json 未变更，拒绝创建空发布提交');
}

runGit(['add', '--', 'package.json']);
runGit(['commit', '--only', 'package.json', '-m', `chore: release v${manifest.version}`]);

function hasPackageChange() {
  try {
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'package.json'], { stdio: 'ignore' });
    return false;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) {
      return true;
    }
    throw error;
  }
}

function runGit(args) {
  execFileSync('git', args, { stdio: 'inherit' });
}
