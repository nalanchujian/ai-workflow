export interface ProcessRunInput {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
  /** Cancels only this child process; used to safely finish a CLI interruption. */
  signal?: AbortSignal;
  onStarted?: (processId: number) => Promise<void> | void;
  /** Explicit child environment. Omit only for trusted local diagnostic commands. */
  env?: NodeJS.ProcessEnv;
}

export interface ProcessRunOutput {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessRunner {
  run(input: ProcessRunInput): Promise<ProcessRunOutput>;
}

export class ExecutableNotFoundError extends Error {
  constructor(readonly executable: string) {
    super(`无法找到可执行文件：${executable}`);
    this.name = 'ExecutableNotFoundError';
  }
}
