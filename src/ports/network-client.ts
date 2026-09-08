export interface NetworkResponse {
  body: string;
  contentType: string;
  location?: string;
  status?: number;
  url: string;
}

export interface NetworkClient {
  fetch(input: {
    url: string;
    timeoutMs: number;
    vettedAddresses?: string[];
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
  }): Promise<NetworkResponse>;
  resolve(hostname: string): Promise<string[]>;
}
