import type { LocalInitializationResult, LocalInitializer } from './local-initializer.js';
import type { LocalConfig } from './local-config.js';
import type { SkillInstaller } from './skill-installer.js';
import type { SkillRegistry } from './skill-registry.js';
import type { LarkConnectorAutoDiscovery, LarkConnectorDiscoveryResult } from './lark-connector-auto-discovery.js';

export interface DefaultWorkflowBootstrapResult extends LocalInitializationResult {
  workflow: {
    profile: string;
    source: { url: string; ref: string };
    revision: string;
    status: 'installed' | 'reused';
  };
  connector?: LarkConnectorDiscoveryResult;
}

export class DefaultWorkflowBootstrapper {
  constructor(private readonly deps: {
    initializer: Pick<LocalInitializer, 'init'>;
    config: Pick<LocalConfig, 'defaultWorkflow'>;
    installer: Pick<SkillInstaller, 'install'>;
    registry: Pick<SkillRegistry, 'findProfile'>;
    larkDiscovery?: Pick<LarkConnectorAutoDiscovery, 'discover'>;
  }) {}

  async init(input: { connectorServer?: string } = {}): Promise<DefaultWorkflowBootstrapResult> {
    const initialized = await this.deps.initializer.init();
    const workflow = await this.deps.config.defaultWorkflow();
    const [name, version] = splitProfileReference(workflow.defaultProfile);
    const existing = await this.deps.registry.findProfile(name, version);
    if (existing !== undefined && existing.registrySource.url === workflow.defaultSkillSource.url) {
      return this.withConnector({
        ...initialized,
        workflow: {
          profile: workflow.defaultProfile,
          source: { ...workflow.defaultSkillSource },
          revision: existing.registrySource.revision,
          status: 'reused',
        },
      }, input);
    }
    let installed: Awaited<ReturnType<SkillInstaller['install']>>;
    try {
      installed = await this.deps.installer.install({ ...workflow.defaultSkillSource });
    } catch (error) {
      throw new Error(`默认工作流安装失败；配置已保留在 ${initialized.configPath}；修复后重新运行 aiw init`, { cause: error });
    }
    const profile = installed.profiles.find((candidate) => candidate.name === name && candidate.version === version);
    if (profile === undefined) {
      throw new Error(`默认技能包未提供工作流模板：${workflow.defaultProfile}`);
    }
    return this.withConnector({
      ...initialized,
      workflow: {
        profile: workflow.defaultProfile,
        source: { ...workflow.defaultSkillSource },
        revision: profile.registrySource.revision,
        status: 'installed',
      },
    }, input);
  }

  private async withConnector(result: Omit<DefaultWorkflowBootstrapResult, 'connector'>, input: { connectorServer?: string }): Promise<DefaultWorkflowBootstrapResult> {
    if (this.deps.larkDiscovery === undefined) {
      return result;
    }
    try {
      return { ...result, connector: await this.deps.larkDiscovery.discover(input.connectorServer === undefined ? {} : { server: input.connectorServer }) };
    } catch {
      return { ...result, connector: { status: 'unavailable' } };
    }
  }
}

function splitProfileReference(reference: string): [string, string] {
  const separator = reference.lastIndexOf('@');
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error(`默认工作流模板格式无效：${reference}`);
  }
  return [reference.slice(0, separator), reference.slice(separator + 1)];
}
