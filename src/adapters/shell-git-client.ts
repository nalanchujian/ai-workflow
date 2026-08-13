import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { GitClient, GitCloneResult } from '../ports/git-client.js';

const execFileAsync = promisify(execFile);

export class ShellGitClient implements GitClient {
  constructor(private readonly cacheDirectory: string) {}

  async clone(input: { url: string; ref?: string }): Promise<GitCloneResult> {
    const key = createHash('sha256').update(`${input.url}\0${input.ref ?? 'HEAD'}`).digest('hex').slice(0, 16);
    const target = join(this.cacheDirectory, `${key}-${randomUUID()}`);
    await mkdir(this.cacheDirectory, { recursive: true });
    try {
      await execFileAsync('git', ['clone', '--quiet', input.url, target]);
      if (input.ref !== undefined) {
        await execFileAsync('git', ['-C', target, 'checkout', '--quiet', '--detach', input.ref]);
      }
      const { stdout } = await execFileAsync('git', ['-C', target, 'rev-parse', 'HEAD']);
      return { directory: target, revision: stdout.trim() };
    } catch (error) {
      await rm(target, { force: true, recursive: true });
      throw new Error('技能仓库克隆失败', { cause: error });
    }
  }
}
