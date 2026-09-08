import type { LocalInitializationResult, LocalInitializer } from './local-initializer.js';
import type { LocalConfig } from './local-config.js';
import type { SkillInstaller } from './skill-installer.js';

export interface DefaultWorkflowBootstrapResult extends LocalInitializationResult {
  workflow: {
    profile: string;
    source: { url: string; ref: string };
    revision: string;
    status: 'installed';
  };
}

export class DefaultWorkflowBootstrapper {
  constructor(private readonly deps: {
    initializer: Pick<LocalInitializer, 'init'>;
    config: Pick<LocalConfig, 'defaultWorkflow'>;
    installer: Pick<SkillInstaller, 'install'>;
  }) {}

  async init(): Promise<DefaultWorkflowBootstrapResult> {
    const initialized = await this.deps.initializer.init();
    const workflow = await this.deps.config.defaultWorkflow();
    let installed: Awaited<ReturnType<SkillInstaller['install']>>;
    try {
      installed = await this.deps.installer.install({ ...workflow.defaultSkillSource });
    } catch (error) {
      throw new Error(`默认工作流安装失败；配置已保留在 ${initialized.configPath}；修复后重新运行 aiw init`, { cause: error });
    }
    const profile = installed.profiles.find((candidate) => candidate.name === workflow.defaultProfile);
    if (profile === undefined) {
      throw new Error(`默认技能包未提供工作流模板：${workflow.defaultProfile}`);
    }
    return {
      ...initialized,
      workflow: {
        profile: workflow.defaultProfile,
        source: { ...workflow.defaultSkillSource },
        revision: profile.registrySource.revision,
        status: 'installed',
      },
    };
  }
}
