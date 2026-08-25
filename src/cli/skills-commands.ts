import { Command } from 'commander';

import type { SkillInstaller } from '../services/skill-installer.js';
import type { SkillRegistry } from '../services/skill-registry.js';
import { writeCommandResult } from './output.js';
import { TerminalProgressReporter, withProgress, type ProgressReporter } from './progress-reporter.js';

export function createSkillsCommand(deps: { installer: SkillInstaller; registry: SkillRegistry; config: LocalConfig; progress?: ProgressReporter; stdout: NodeJS.WriteStream }): Command {
  const command = new Command('skills').description('高级：管理团队技能和工作流模板');
  command.addCommand(new Command('install')
    .description('安装技能包和工作流模板')
    .argument('<git-url>')
    .option('--ref <ref>', 'Git 分支、标签或提交')
    .action(async (url: string, options: { ref?: string }, command: Command) => {
      const result = await withProgress({
        reporter: deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr }),
        command,
        start: '正在下载并校验团队技能包',
        success: '团队技能包已安装',
        failure: '团队技能包安装失败',
        operation: () => deps.installer.install({ url, ...(options.ref === undefined ? {} : { ref: options.ref }) }),
      });
      const skills = result.skills.map((skill) => ({ name: skill.name, version: skill.version }));
      const profiles = result.profiles.map((profile) => ({ name: profile.name }));
      writeCommandResult({ skills, profiles }, command, deps.stdout, {
        headline: '团队技能包已安装',
        sections: [
          { title: '可用技能', lines: skills.map((skill) => `${skill.name}@${skill.version}`) },
          { title: '工作流模板', lines: profiles.map((profile) => profile.name) },
        ],
        nextSteps: ['aiw skills profiles list'],
      });
    }));
  command.addCommand(new Command('update')
    .description('安装并切换本机默认团队技能版本')
    .requiredOption('--ref <tag-or-commit>', '目标 Git 标签或提交')
    .action(async (options: { ref: string }, command: Command) => {
      const updated = await withProgress({
        reporter: deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr }),
        command,
        start: '正在更新并校验团队技能包',
        success: '团队技能包已更新',
        failure: '团队技能包更新失败',
        operation: async () => {
          const workflow = await deps.config.defaultWorkflow();
          const result = await deps.installer.install({ url: workflow.defaultSkillSource.url, ref: options.ref });
          const profile = result.profiles.find((candidate) => candidate.name === workflow.defaultProfile);
          if (profile === undefined) {
            throw new Error(`更新的技能包未提供当前默认工作流：${workflow.defaultProfile}`);
          }
          const config = await deps.config.updateDefaultWorkflow({ ref: options.ref, profile: profile.name });
          return { config, result };
        },
      });
      const output = {
        defaultProfile: updated.config.defaultProfile,
        defaultSkillSource: updated.config.defaultSkillSource,
        skills: updated.result.skills.map((skill) => ({ name: skill.name, version: skill.version })),
        profiles: updated.result.profiles.map((profile) => ({ name: profile.name })),
      };
      writeCommandResult(output, command, deps.stdout, {
        headline: '默认工作流已更新',
        details: [
          { label: '默认工作流', value: output.defaultProfile },
          { label: '技能包版本', value: updated.config.defaultSkillSource.ref },
        ],
        sections: [{ title: '可用模板', lines: output.profiles.map((profile) => profile.name) }],
        nextSteps: ['后续新建任务会使用该默认工作流。'],
      });
    }));
  command.addCommand(new Command('list')
    .description('列出已安装技能')
    .action(async (_options: unknown, command: Command) => {
      const skills = await deps.registry.list();
      writeCommandResult(skills, command, deps.stdout, {
        headline: skills.length === 0 ? '尚未安装技能' : `已安装 ${skills.length} 个技能`,
        sections: skills.length === 0 ? undefined : [{ title: '技能', lines: skills.map((skill) => `${skill.name}@${skill.version}：${skill.description}`) }],
        nextSteps: skills.length === 0 ? ['aiw init'] : undefined,
      });
    }));
  const profiles = new Command('profiles').description('管理工作流模板');
  profiles.addCommand(new Command('list')
    .description('列出已安装工作流模板')
    .action(async (_options: unknown, command: Command) => {
      const profiles = await deps.registry.listProfiles();
      writeCommandResult(profiles, command, deps.stdout, {
        headline: profiles.length === 0 ? '尚未安装工作流模板' : `已安装 ${profiles.length} 个工作流模板`,
        sections: profiles.length === 0 ? undefined : [{ title: '工作流模板', lines: profiles.map((profile) => `${profile.name}：${profile.description}`) }],
        nextSteps: profiles.length === 0 ? ['aiw init'] : undefined,
      });
    }));
  command.addCommand(profiles);
  return command;
}
import type { LocalConfig } from '../services/local-config.js';
