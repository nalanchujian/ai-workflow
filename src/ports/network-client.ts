export interface NetworkResponse {
  body: string;
  contentType: string;
  location?: string;
  status?: number;
  url: string;
}

export interface NetworkClient {
  fetch(input: { url: string; timeoutMs: number }): Promise<NetworkResponse>;
  resolve(hostname: string): Promise<string[]>;
}
