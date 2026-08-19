import type { ProcessRunInput } from '../ports/process-runner.js';

/**
 * Verification commands are persisted in an approved plan and later executed
 * by AIW without a shell. Keep their grammar deliberately small so prose and
 * shell fragments cannot turn into misleading test evidence.
 */
export function parseVerificationCommand(command: string): Pick<ProcessRunInput, 'command' | 'args'> {
  if (command.trim() === '') throw new Error('验证命令不能为空');
  if (command !== command.trim() || /[\r\n]/.test(command)) {
    throw new Error('验证命令必须是一行命令，不能包含首尾空白或换行。');
  }
  if (/[^\x20-\x7E]/.test(command)) {
    throw new Error('验证命令必须是可执行命令，不能使用自然语言描述。');
  }
  if (/[|;&<>`]|\$\(/.test(command)) {
    throw new Error('验证命令不能包含 shell 管道、重定向、串联或命令替换；请使用单一可执行命令。');
  }
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
  const [executable, ...args] = tokens;
  if (executable === undefined) throw new Error('验证命令不能为空');
  if (!/^[A-Za-z0-9_./:@+=-]+$/.test(executable)) {
    throw new Error('验证命令的可执行程序格式无效。');
  }
  if ((executable === 'pnpm' || executable === 'npm') && args[0] === 'run' && args[2] === '--') {
    throw new Error(`\`${executable} run <脚本> -- --<参数>\` 会向脚本传入多余的 \`--\`；请改为项目脚本，或使用 \`${executable} exec <命令> --<参数>\`。`);
  }
  return { command: executable, args };
}

export function verificationCommandError(command: string): string | undefined {
  try {
    parseVerificationCommand(command);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : '验证命令无效。';
  }
}
