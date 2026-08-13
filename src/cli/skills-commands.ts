import { Command } from 'commander';

import type { SkillInstaller } from '../services/skill-installer.js';
import type { SkillRegistry } from '../services/skill-registry.js';
import { writeCommandResult } from './output.js';

export function createSkillsCommand(deps: { installer: SkillInstaller; registry: SkillRegistry; config: LocalConfig; stdout: NodeJS.WriteStream }): Command {
  const command = new Command('skills').description('管理团队技能和工作流模板');
  command.addCommand(new Command('install')
    .description('安装技能包和工作流模板')
    .argument('<git-url>')
    .option('--ref <ref>', 'Git 分支、标签或提交')
    .action(async (url: string, options: { ref?: string }, command: Command) => {
      const result = await deps.installer.install({ url, ...(options.ref === undefined ? {} : { ref: options.ref }) });
      writeCommandResult({ skills: result.skills.map((skill) => ({ name: skill.name, version: skill.version })), profiles: result.profiles.map((profile) => ({ name: profile.name, version: profile.version })) }, command, deps.stdout);
    }));
  command.addCommand(new Command('update')
    .description('安装并切换本机默认团队技能版本')
    .requiredOption('--ref <tag-or-commit>', '目标 Git 标签或提交')
    .action(async (options: { ref: string }, command: Command) => {
      const workflow = await deps.config.defaultWorkflow();
      const result = await deps.installer.install({ url: workflow.defaultSkillSource.url, ref: options.ref });
      const updated = await deps.config.updateDefaultWorkflowRef(options.ref);
      writeCommandResult({
        defaultProfile: updated.defaultProfile,
        defaultSkillSource: updated.defaultSkillSource,
        skills: result.skills.map((skill) => ({ name: skill.name, version: skill.version })),
        profiles: result.profiles.map((profile) => ({ name: profile.name, version: profile.version })),
      }, command, deps.stdout);
    }));
  command.addCommand(new Command('list')
    .description('列出已安装技能')
    .action(async (_options: unknown, command: Command) => writeCommandResult(await deps.registry.list(), command, deps.stdout)));
  const profiles = new Command('profiles').description('管理工作流模板');
  profiles.addCommand(new Command('list')
    .description('列出已安装工作流模板')
    .action(async (_options: unknown, command: Command) => writeCommandResult(await deps.registry.listProfiles(), command, deps.stdout)));
  command.addCommand(profiles);
  return command;
}
import type { LocalConfig } from '../services/local-config.js';
