import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTempDirectory(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}
