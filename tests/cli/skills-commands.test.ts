import { describe, expect, it } from 'vitest';

import { createSkillsCommand } from '../../src/cli/skills-commands.js';

describe('skills commands', () => {
  it('lists installed workflow profiles', async () => {
    let output = '';
    const command = createSkillsCommand({
      installer: {} as never,
      registry: { async list() { return []; }, async listProfiles() { return [{ name: 'standard-web-feature' }]; } } as never,
      config: {} as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'skills', 'profiles', 'list']);

    expect(output).toContain('standard-web-feature');
  });

  it('installs a requested package ref while keeping the matching profile name', async () => {
    const calls: string[] = [];
    const command = createSkillsCommand({
      installer: { async install(input: { url: string; ref: string }) { calls.push(`install:${input.url}@${input.ref}`); return { skills: [], profiles: [{ name: 'standard-web-feature' }] }; } } as never,
      registry: {} as never,
      config: {
        async defaultWorkflow() { return { defaultSkillSource: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.0.0' }, defaultProfile: 'standard-web-feature' }; },
        async updateDefaultWorkflow(input: { ref: string; profile: string }) { calls.push(`config:${input.ref}:${input.profile}`); return { defaultSkillSource: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: input.ref }, defaultProfile: input.profile }; },
      } as never,
      stdout: { write() { return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'skills', 'update', '--ref', 'v2.1.0']);

    expect(calls).toEqual([
      'install:https://github.com/nalanchujian/ai-workflow-skills.git@v2.1.0',
      'config:v2.1.0:standard-web-feature',
    ]);
  });

  it('keeps the default configuration unchanged when the installed package lacks its default profile', async () => {
    const calls: string[] = [];
    const command = createSkillsCommand({
      installer: { async install() { calls.push('install'); return { skills: [], profiles: [{ name: 'backend-service' }] }; } } as never,
      registry: {} as never,
      config: {
        async defaultWorkflow() { return { defaultSkillSource: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.0.0' }, defaultProfile: 'standard-web-feature' }; },
        async updateDefaultWorkflow() { calls.push('config'); throw new Error('不应更新'); },
      } as never,
      stdout: { write() { return true; } } as unknown as NodeJS.WriteStream,
    });

    await expect(command.parseAsync(['node', 'skills', 'update', '--ref', 'v3.0.0']))
      .rejects.toThrow('更新的技能包未提供当前默认工作流：standard-web-feature');
    expect(calls).toEqual(['install']);
  });
});
