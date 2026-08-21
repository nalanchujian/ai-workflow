import { rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const distDirectory = resolve(join(repositoryRoot, 'dist'));

if (relative(repositoryRoot, distDirectory) !== 'dist') {
  throw new Error(`拒绝清理非预期目录：${distDirectory}`);
}

await rm(distDirectory, { recursive: true, force: true });
