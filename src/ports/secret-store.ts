/** Stores a small user-owned secret payload outside AIW's YAML configuration. */
export interface SecretStore {
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
