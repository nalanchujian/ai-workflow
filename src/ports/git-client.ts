export interface GitCloneResult {
  directory: string;
  revision: string;
}

export interface GitClient {
  clone(input: { url: string; ref?: string }): Promise<GitCloneResult>;
}
