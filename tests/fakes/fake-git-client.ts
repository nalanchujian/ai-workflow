import type { GitClient, GitCloneResult } from '../../src/ports/git-client.js';
import type { RepositoryStatus } from '../../src/ports/repository-status.js';
import type { ProjectRepository } from '../../src/ports/project-repository.js';

export class FakeGitClient implements GitClient {
  constructor(private readonly repositories: Record<string, GitCloneResult>) {}

  async clone(input: { url: string; ref?: string }): Promise<GitCloneResult> {
    const repository = this.repositories[input.url];
    if (repository === undefined) {
      throw new Error(`未知技能仓库：${input.url}`);
    }
    return repository;
  }
}

export class FakeRepositoryStatus implements RepositoryStatus, ProjectRepository {
  private committed = false;
  private paths: string[] = [];
  private workingDiff = '';

  commitTaskFacts(): void {
    this.committed = true;
  }

  markDirty(): void {
    this.committed = false;
  }

  setChangedPaths(paths: string[]): void {
    this.paths = paths;
  }

  setDiff(diff: string): void {
    this.workingDiff = diff;
  }

  async assertProjectReady(): Promise<void> {}

  async uncommittedPaths(input: { projectRoot: string; paths: string[] }): Promise<string[]> {
    return this.committed ? [] : input.paths;
  }

  async changedPaths(): Promise<string[]> {
    return this.paths;
  }

  async untrackedPaths(): Promise<string[]> {
    return this.paths;
  }

  async diff(): Promise<string> {
    return this.workingDiff;
  }

  async revision(): Promise<{ head?: string; branch?: string }> {
    return { head: 'test-head', branch: 'test' };
  }

  async authorName(): Promise<string | undefined> {
    return 'test-user';
  }
}
