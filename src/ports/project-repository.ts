export interface ProjectRepository {
  assertProjectReady(projectRoot: string): Promise<void>;
}

export class ProjectRepositoryError extends Error {
  constructor(readonly code: 'PROJECT_NOT_GIT' | 'AIW_IGNORED', message: string) {
    super(message);
    this.name = 'ProjectRepositoryError';
  }
}
