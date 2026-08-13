import type { Command } from 'commander';

export interface ProgressHandle {
  succeed(message?: string): void;
  fail(message?: string): void;
  update(message: string): void;
}

export interface ProgressReporter {
  start(command: Command, message: string): ProgressHandle;
}

export async function withProgress<T>(input: {
  reporter: ProgressReporter;
  command: Command;
  start: string;
  success: string;
  failure: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const progress = input.reporter.start(input.command, input.start);
  try {
    const result = await input.operation();
    progress.succeed(input.success);
    return result;
  } catch (error) {
    progress.fail(input.failure);
    throw error;
  }
}

export class TerminalProgressReporter implements ProgressReporter {
  private readonly spinnerIntervalMs: number;

  constructor(private readonly deps: { stderr: NodeJS.WriteStream; spinnerIntervalMs?: number }) {
    this.spinnerIntervalMs = deps.spinnerIntervalMs ?? 120;
  }

  start(command: Command, message: string): ProgressHandle {
    if (this.deps.stderr.isTTY !== true || command.optsWithGlobals().json === true) {
      return silentProgress;
    }
    let currentMessage = message;
    let frame = 0;
    let active = true;
    const startedAt = Date.now();
    const frames = ['◐', '◓', '◑', '◒'];
    const render = (): void => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const suffix = elapsed === 0 ? '' : `（已等待 ${elapsed}s）`;
      this.deps.stderr.write(`\r${frames[frame % frames.length]} ${currentMessage}${suffix}`);
      frame += 1;
    };
    render();
    const timer = setInterval(render, this.spinnerIntervalMs);
    const finish = (symbol: '✓' | '✗', finalMessage?: string): void => {
      if (!active) {
        return;
      }
      active = false;
      clearInterval(timer);
      this.deps.stderr.write(`\r${symbol} ${finalMessage ?? currentMessage}\n`);
    };
    return {
      update(nextMessage: string) {
        currentMessage = nextMessage;
        render();
      },
      succeed(finalMessage?: string) {
        finish('✓', finalMessage);
      },
      fail(finalMessage?: string) {
        finish('✗', finalMessage);
      },
    };
  }
}

const silentProgress: ProgressHandle = {
  update() {},
  succeed() {},
  fail() {},
};
