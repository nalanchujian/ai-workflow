export interface CapturedDesignRoot {
  fileKey: string;
  nodeId: string;
  metadata: string;
  screenshot: Buffer;
  capturedAt: string;
}

export interface CapturedDesignNode {
  designContext: string;
  screenshot: Buffer;
}

export interface DesignConnector {
  supports(url: string): boolean;
  captureRoot(input: { url: string }): Promise<CapturedDesignRoot>;
  captureNode(input: { url: string; nodeId: string }): Promise<CapturedDesignNode>;
}
