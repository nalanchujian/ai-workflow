import { Command } from 'commander';

import type { SkillInstaller } from '../services/skill-installer.js';
import type { SkillRegistry } from '../services/skill-registry.js';
import { writeResult } from './output.js';

export function createSkillsCommand(deps: { installer: SkillInstaller; registry: SkillRegistry; stdout: NodeJS.WriteStream }): Command {
  const command = new Command('skills').description('管理团队技能和工作流模板');
  command.addCommand(new Command('install')
    .description('安装技能包和工作流模板')
    .argument('<git-url>')
    .option('--ref <ref>', 'Git 分支、标签或提交')
    .action(async (url: string, options: { ref?: string }) => {
      const result = await deps.installer.install({ url, ...(options.ref === undefined ? {} : { ref: options.ref }) });
      writeResult({ skills: result.skills.map((skill) => ({ name: skill.name, version: skill.version })), profiles: result.profiles.map((profile) => ({ name: profile.name, version: profile.version })) }, { json: false, stdout: deps.stdout });
    }));
  command.addCommand(new Command('list')
    .description('列出已安装技能')
    .action(async () => writeResult(await deps.registry.list(), { json: false, stdout: deps.stdout })));
  const profiles = new Command('profiles').description('管理工作流模板');
  profiles.addCommand(new Command('list')
    .description('列出已安装工作流模板')
    .action(async () => writeResult(await deps.registry.listProfiles(), { json: false, stdout: deps.stdout })));
  command.addCommand(profiles);
  return command;
}
