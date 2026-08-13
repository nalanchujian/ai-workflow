import { describe, expect, it } from 'vitest';

import { createSkillsCommand } from '../../src/cli/skills-commands.js';

describe('skills commands', () => {
  it('lists installed workflow profiles', async () => {
    let output = '';
    const command = createSkillsCommand({
      installer: {} as never,
      registry: { async list() { return []; }, async listProfiles() { return [{ name: 'standard-web-feature', version: '1.0.0' }]; } } as never,
      config: {} as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'skills', 'profiles', 'list']);

    expect(output).toContain('standard-web-feature');
  });

  it('installs a requested default-workflow ref before recording it in local config', async () => {
    const calls: string[] = [];
    const command = createSkillsCommand({
      installer: { async install(input: { url: string; ref: string }) { calls.push(`install:${input.url}@${input.ref}`); return { skills: [], profiles: [{ name: 'standard-web-feature', version: '2.1.0' }] }; } } as never,
      registry: {} as never,
      config: {
        async defaultWorkflow() { return { defaultSkillSource: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.0.0' }, defaultProfile: 'standard-web-feature@2.0.0' }; },
        async updateDefaultWorkflowRef(ref: string) { calls.push(`config:${ref}`); return { defaultSkillSource: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref }, defaultProfile: 'standard-web-feature@2.0.0' }; },
      } as never,
      stdout: { write() { return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'skills', 'update', '--ref', 'v2.1.0']);

    expect(calls).toEqual([
      'install:https://github.com/nalanchujian/ai-workflow-skills.git@v2.1.0',
      'config:v2.1.0',
    ]);
  });
});
