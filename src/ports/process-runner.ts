export interface ProcessRunInput {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
}

export interface ProcessRunOutput {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
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
