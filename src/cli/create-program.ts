import { Command } from 'commander';

export interface CliDependencies {
  version: string;
}

export function createProgram(deps: CliDependencies): Command {
  return new Command()
    .name('aiw')
    .description('Git 原生的 AI 研发变更治理 CLI')
    .version(deps.version)
    .option('--json', '以单个 JSON 文档输出结果')
    .addCommand(new Command('skills').description('管理团队技能和工作流模板'))
    .addCommand(new Command('task').description('管理研发任务和阶段执行'));
}
