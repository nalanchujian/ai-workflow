export interface BrowserOpener {
  open(url: string): Promise<void>;
}
