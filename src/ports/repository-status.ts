export interface RepositoryStatus {
  uncommittedPaths(input: { projectRoot: string; paths: string[] }): Promise<string[]>;
  authorName?(): Promise<string | undefined>;
}
