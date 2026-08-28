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
    .option('--json', '以单个 JSON 文档输出结果')
    .addHelpText('after', `

首次使用：
  aiw init → aiw doctor

日常使用：
  aiw task init --source "<需求地址或文件>"
  可选设计图：重复增加 --design-image <本地 PNG/JPEG 路径>
  aiw task run <task-id> clarify
  AIW 每一步都会输出下一条精准命令，包括 review、approve 或具体节点的 run 命令。

高级与例外场景：
  aiw skills --help（高级：管理团队技能和工作流模板）
  aiw history --help（查看和清理本机运行记录）
  aiw task --help（查看任务推进、来源刷新和取消命令）
`);
  if (deps.runtime === undefined) {
    program.addCommand(new Command('doctor').description('检查本机研发环境与可执行修复建议'));
    program.addCommand(new Command('init').description('初始化本机 AI Workflow 配置模板'));
    program.addCommand(new Command('history').description('查看和清理本机运行记录'), { hidden: true });
    program.addCommand(new Command('skills').description('高级：管理团队技能和工作流模板'), { hidden: true });
    return program.addCommand(taskHelpShell());
  }
  const runtime = deps.runtime;
  const stdout = deps.stdout ?? process.stdout;
  const progress = new TerminalProgressReporter({ stderr: deps.stderr ?? process.stderr });
  program.addCommand(createInitCommand({ bootstrapper: runtime.defaultWorkflowBootstrapper, progress, stdout }));
  program.addCommand(createDoctorCommand({ doctor: runtime.doctor, progress, stdout }));
  program.addCommand(createRunHistoryCommand({ history: runtime.runHistory, progress, stdout }), { hidden: true });
  program.addCommand(createSkillsCommand({ installer: runtime.installer, registry: runtime.registry, config: runtime.localConfig, progress, stdout }), { hidden: true });
  const task = taskHelpShell(false);
  task.addCommand(createTaskInitCommand({ initializer: runtime.initializer, defaultSkillProfile: async () => (await runtime.localConfig.defaultWorkflow()).defaultProfile, progress, stdout }));
  task.addCommand(new Command('source').description('管理任务来源').addCommand(createTaskSourceRefreshCommand({ refresher: runtime.sourceRefresher, progress, stdout })), { hidden: true });
  const state = createTaskStateCommand({ commands: runtime.stateCommands, progress, stdout });
  task.addCommand(createTaskRunCommand({ runner: runtime.taskRunner, taskState: runtime.stateCommands, progress, stdout }));
  for (const command of state.commands) {
    task.addCommand(command, { hidden: command.name() === 'cancel' });
  }
  return program.addCommand(task);
}

function taskHelpShell(withCommands = true): Command {
  const task = new Command('task')
    .description('管理研发任务')
    .addHelpText('after', `
高级与例外命令：
  aiw task source refresh --help          刷新需求来源
  aiw task cancel --help                  取消正在运行的节点
  aiw task ignore --help                  忽略不属于当前任务范围的开发单元
`);
  if (!withCommands) return task;
  task.addCommand(new Command('init').description('从需求来源创建任务'));
  task.addCommand(new Command('run').description('运行指定任务节点'));
  task.addCommand(new Command('review').description('确认需求澄清事项'));
  task.addCommand(new Command('approve').description('批准开发计划'));
  task.addCommand(new Command('ignore').description('忽略不属于当前任务范围的开发单元'));
  task.addCommand(new Command('status').description('查看任务状态和开发进度'));
  return task;
}
