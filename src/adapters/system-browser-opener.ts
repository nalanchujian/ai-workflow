import type { BrowserOpener } from '../ports/browser-opener.js';
import type { ProcessRunner } from '../ports/process-runner.js';

export class SystemBrowserOpener implements BrowserOpener {
  constructor(private readonly deps: { processRunner: ProcessRunner; cwd: () => string }) {}

  async open(url: string): Promise<void> {
    const result = await this.deps.processRunner.run({ command: 'open', args: [url], cwd: this.deps.cwd(), stdin: '', timeoutMs: 10_000 });
    if (result.exitCode !== 0 || result.timedOut) throw new Error('无法打开系统浏览器');
  }
}
