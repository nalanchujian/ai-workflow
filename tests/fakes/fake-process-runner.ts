import type { ProcessRunInput, ProcessRunOutput, ProcessRunner } from '../../src/ports/process-runner.js';

export class FakeProcessRunner implements ProcessRunner {
  readonly calls: ProcessRunInput[] = [];
  onRun?: (input: ProcessRunInput) => Promise<void>;

  async run(input: ProcessRunInput): Promise<ProcessRunOutput> {
    this.calls.push(input);
    await this.onRun?.(input);
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
  }
}
