import { Command } from 'commander';

import { createDoctorCommand } from './doctor-command.js';
import { createInitCommand } from './init-command.js';
import { createRunHistoryCommand } from './run-history-command.js';
import { createSkillsCommand } from './skills-commands.js';
import { createTaskInitCommand } from './task-init-command.js';
import { createTaskRunCommand } from './task-run-command.js';
import { createTaskSourceRefreshCommand } from './task-source-refresh-command.js';
import { createTaskStateCommand } from './task-state-commands.js';
import type { CliRuntime } from './create-runtime.js';
import { TerminalProgressReporter } from './progress-reporter.js';

export interface CliDependencies {
  version: string;
  runtime?: CliRuntime;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export function createProgram(deps: CliDependencies): Command {
  const program = new Command()
    .name('aiw')
    .description('Git 原生的 AI 研发变更治理 CLI')
    .version(deps.version)
    .option('--json', '以单个 JSON 文档输出结果');
  if (deps.runtime === undefined) {
    return program
      .addCommand(new Command('doctor').description('检查本机研发环境与可执行修复建议'))
      .addCommand(new Command('init').description('初始化本机 AI Workflow 配置模板'))
      .addCommand(new Command('run').description('查看和清理本机运行记录'))
      .addCommand(new Command('skills').description('管理团队技能和工作流模板'))
      .addCommand(new Command('task').description('管理研发任务和阶段执行'));
  }
  const runtime = deps.runtime;
  const stdout = deps.stdout ?? process.stdout;
  const progress = new TerminalProgressReporter({ stderr: deps.stderr ?? process.stderr });
  program.addCommand(createInitCommand({ bootstrapper: runtime.defaultWorkflowBootstrapper, progress, stdout }));
  program.addCommand(createDoctorCommand({ doctor: runtime.doctor, progress, stdout }));
  program.addCommand(createRunHistoryCommand({ history: runtime.runHistory, progress, stdout }));
  program.addCommand(createSkillsCommand({ installer: runtime.installer, registry: runtime.registry, config: runtime.localConfig, progress, stdout }));
  const task = new Command('task').description('管理研发任务和阶段执行');
  task.addCommand(createTaskInitCommand({ initializer: runtime.initializer, defaultSkillProfile: async () => (await runtime.localConfig.defaultWorkflow()).defaultProfile, progress, stdout }));
  task.addCommand(new Command('source').description('管理任务来源').addCommand(createTaskSourceRefreshCommand({ refresher: runtime.sourceRefresher, progress, stdout })));
  task.addCommand(createTaskRunCommand({ runner: runtime.taskRunner, progress, stdout }));
  const state = createTaskStateCommand({ commands: runtime.stateCommands, stdout });
  for (const command of state.commands) {
    task.addCommand(command);
  }
  return program.addCommand(task);
}
