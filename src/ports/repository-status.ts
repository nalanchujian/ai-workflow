export interface RepositoryStatus {
  uncommittedPaths(input: { projectRoot: string; paths: string[] }): Promise<string[]>;
  authorName?(): Promise<string | undefined>;
}

export interface WorkingTreeStatus {
  changedPaths(input: { projectRoot: string }): Promise<string[]>;
  untrackedPaths(input: { projectRoot: string }): Promise<string[]>;
  diff(input: { projectRoot: string }): Promise<string>;
  revision(input: { projectRoot: string }): Promise<{ head?: string; branch?: string }>;
}
