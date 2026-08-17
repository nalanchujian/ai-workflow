import { Command } from 'commander';

import type { DoctorService } from '../services/doctor-service.js';
import { writeCommandResult } from './output.js';
import { TerminalProgressReporter, withProgress, type ProgressReporter } from './progress-reporter.js';

export function createDoctorCommand(deps: { doctor: DoctorService; progress?: ProgressReporter; stdout: NodeJS.WriteStream }): Command {
  return new Command('doctor')
    .description('检查本机研发环境与可执行修复建议')
    .option('--project <path>', '要检查的业务仓库，默认当前目录')
    .option('--source <reference>', '可选：验证指定需求文档对应的来源连接器')
    .action(async (options: { project?: string; source?: string }, command: Command) => {
      const result = await withProgress({
        reporter: deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr }),
        command,
        start: '正在检查本机研发环境',
        success: '本机环境检查完成',
        failure: '本机环境检查失败',
        operation: () => deps.doctor.inspect({ projectRoot: options.project ?? process.cwd(), ...(options.source === undefined ? {} : { source: options.source }) }),
      });
      writeCommandResult(result, command, deps.stdout, {
        headline: result.ok ? '本机环境检查通过' : '本机环境需要处理',
        sections: result.checks.length === 0 ? [{ title: '检查结果', lines: ['未返回检查项'] }] : [{
          title: '检查结果',
          lines: result.checks.map((check) => `${doctorStatusLabel(check.status)} ${check.label}：${check.message}${check.suggestion === undefined ? '' : `（建议：${check.suggestion}）`}`),
        }],
        ...(result.ok ? {} : { nextSteps: ['按“建议”修复后重新执行 aiw doctor'] }),
      });
    });
}

function doctorStatusLabel(status: 'passed' | 'warning' | 'failed'): string {
  return ({ passed: '✓', warning: '!', failed: '✗' })[status];
}
