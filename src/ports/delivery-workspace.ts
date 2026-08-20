export interface DeliveryWorkspacePublishResult {
  published: boolean;
  patch: string;
  patchSha256: string;
  changedPaths: string[];
}

export interface DeliveryWorkspace {
  projectRoot: string;
  sourceHead: string;
  publish(): Promise<DeliveryWorkspacePublishResult>;
  rollback(): Promise<void>;
  dispose(): Promise<void>;
}

export interface DeliveryWorkspaceManager {
  prepare(input: {
    projectRoot: string;
    runtimeRoot: string;
    taskId: string;
    nodeId: string;
    runId: string;
  }): Promise<DeliveryWorkspace>;
}
