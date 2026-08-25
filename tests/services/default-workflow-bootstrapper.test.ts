import { describe, expect, it } from 'vitest';

import { DefaultWorkflowBootstrapper } from '../../src/services/default-workflow-bootstrapper.js';

describe('DefaultWorkflowBootstrapper', () => {
  it('installs the configured source when its default profile is absent', async () => {
    const installed: unknown[] = [];
    const bootstrapper = new DefaultWorkflowBootstrapper({
      initializer: { async init() { return { schemaVersion: 'aiw.init/v1', status: 'created', configPath: '/home/j/.aiw/config.yaml' }; } },
      config: { async defaultWorkflow() { return { defaultSkillSource: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.1.0' }, defaultProfile: 'standard-web-feature' }; } },
      installer: { async install(input: unknown) { installed.push(input); return { skills: [], profiles: [{ name: 'standard-web-feature', registrySource: { revision: 'resolved-revision' } }], methods: [] }; } } as never,
    });

    await expect(bootstrapper.init()).resolves.toMatchObject({
      configPath: '/home/j/.aiw/config.yaml',
      workflow: { profile: 'standard-web-feature', status: 'installed', revision: 'resolved-revision' },
    });
    expect(installed).toEqual([{ url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.1.0' }]);
  });

  it('reinstalls the configured ref even when the named profile already exists', async () => {
    const installed: unknown[] = [];
    const bootstrapper = new DefaultWorkflowBootstrapper({
      initializer: { async init() { return { schemaVersion: 'aiw.init/v1', status: 'already-initialized', configPath: '/home/j/.aiw/config.yaml' }; } },
      config: { async defaultWorkflow() { return { defaultSkillSource: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.1.0' }, defaultProfile: 'standard-web-feature' }; } },
      installer: { async install(input: unknown) { installed.push(input); return { skills: [], profiles: [{ name: 'standard-web-feature', registrySource: { revision: 'current-revision' } }], methods: [] }; } } as never,
    });

    await expect(bootstrapper.init()).resolves.toMatchObject({
      workflow: { profile: 'standard-web-feature', status: 'installed', revision: 'current-revision' },
    });
    expect(installed).toEqual([{ url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.1.0' }]);
  });

  it('keeps the config and reports how to retry when the default package cannot install', async () => {
    const bootstrapper = new DefaultWorkflowBootstrapper({
      initializer: { async init() { return { schemaVersion: 'aiw.init/v1', status: 'created', configPath: '/home/j/.aiw/config.yaml' }; } },
      config: { async defaultWorkflow() { return { defaultSkillSource: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.1.0' }, defaultProfile: 'standard-web-feature' }; } },
      installer: { async install() { throw new Error('Git ref 不存在'); } } as never,
    });

    await expect(bootstrapper.init()).rejects.toThrow('配置已保留在 /home/j/.aiw/config.yaml；修复后重新运行 aiw init');
  });
});
