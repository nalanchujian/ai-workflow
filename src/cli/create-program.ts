import { Command } from 'commander';

import { createSkillsCommand } from './skills-commands.js';
import { createTaskInitCommand } from './task-init-command.js';
import { createTaskRunCommand } from './task-run-command.js';
import { createTaskSourceRefreshCommand } from './task-source-refresh-command.js';
import { createTaskStateCommand } from './task-state-commands.js';
import type { CliRuntime } from './create-runtime.js';

export interface CliDependencies {
  version: string;
  runtime?: CliRuntime;
  stdout?: NodeJS.WriteStream;
}

export function createProgram(deps: CliDependencies): Command {
  const program = new Command()
    .name('aiw')
    .description('Git 原生的 AI 研发变更治理 CLI')
    .version(deps.version)
    .option('--json', '以单个 JSON 文档输出结果');
  if (deps.runtime === undefined) {
    return program
      .addCommand(new Command('skills').description('管理团队技能和工作流模板'))
      .addCommand(new Command('task').description('管理研发任务和阶段执行'));
  }
  const stdout = deps.stdout ?? process.stdout;
  program.addCommand(createSkillsCommand({ installer: deps.runtime.installer, registry: deps.runtime.registry, stdout }));
  const task = new Command('task').description('管理研发任务和阶段执行');
  task.addCommand(createTaskInitCommand({ initializer: deps.runtime.initializer, stdout }));
  task.addCommand(new Command('source').description('管理任务来源').addCommand(createTaskSourceRefreshCommand({ refresher: deps.runtime.sourceRefresher, stdout })));
  task.addCommand(createTaskRunCommand({ runner: deps.runtime.taskRunner, stdout }));
  const state = createTaskStateCommand({ commands: deps.runtime.stateCommands, stdout });
  for (const command of state.commands) {
    task.addCommand(command);
  }
  return program.addCommand(task);
}
