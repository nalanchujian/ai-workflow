import { chmod } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const cliPath = resolve(join(repositoryRoot, 'dist', 'cli.js'));

if (relative(repositoryRoot, cliPath) !== join('dist', 'cli.js')) {
  throw new Error(`拒绝修改非预期文件权限：${cliPath}`);
}

await chmod(cliPath, 0o755);
