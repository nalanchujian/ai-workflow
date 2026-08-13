import { Command } from 'commander';

import type { DoctorService } from '../services/doctor-service.js';
import { writeCommandResult } from './output.js';
import { TerminalProgressReporter, withProgress, type ProgressReporter } from './progress-reporter.js';

export function createDoctorCommand(deps: { doctor: DoctorService; progress?: ProgressReporter; stdout: NodeJS.WriteStream }): Command {
  return new Command('doctor')
    .description('检查本机研发环境与可执行修复建议')
    .option('--project <path>', '要检查的业务仓库，默认当前目录')
    .option('--lark-url <url>', '显式验证可读取的 Lark docx 文档')
    .action(async (options: { project?: string; larkUrl?: string }, command: Command) => {
      const result = await withProgress({
        reporter: deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr }),
        command,
        start: '正在检查本机研发环境',
        success: '本机环境检查完成',
        failure: '本机环境检查失败',
        operation: () => deps.doctor.inspect({ projectRoot: options.project ?? process.cwd(), ...(options.larkUrl === undefined ? {} : { larkUrl: options.larkUrl }) }),
      });
      writeCommandResult(result, command, deps.stdout);
    });
}
