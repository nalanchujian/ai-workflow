import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';

import { officialDefaultWorkflow } from './default-workflow.js';

export interface LocalInitializationResult {
  schemaVersion: 'aiw.init/v1';
  status: 'created' | 'updated' | 'already-initialized';
  configPath: string;
}

/** Creates the user-owned, optional local connector configuration once. */
export class LocalInitializer {
  constructor(private readonly path: string) {}

  async init(): Promise<LocalInitializationResult> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(this.path, localConfigTemplate, { encoding: 'utf8', flag: 'wx' });
      return { schemaVersion: 'aiw.init/v1', status: 'created', configPath: this.path };
    } catch (error) {
      if (isAlreadyExists(error)) {
        if (await this.addMissingWorkflowDefaults()) {
          return { schemaVersion: 'aiw.init/v1', status: 'updated', configPath: this.path };
        }
        return { schemaVersion: 'aiw.init/v1', status: 'already-initialized', configPath: this.path };
      }
      throw error;
    }
  }

  private async addMissingWorkflowDefaults(): Promise<boolean> {
    const document = parse(await readFile(this.path, 'utf8'));
    if (document === null || typeof document !== 'object' || Array.isArray(document) || 'workflow' in document) {
      return false;
    }
    await writeFile(this.path, stringify({ ...document, workflow: officialDefaultWorkflow }), 'utf8');
    return true;
  }
}

const localConfigTemplate = `# AI Workflow 本机配置；此文件仅保存个人连接器和默认工作流设置，不得提交到业务仓库。
# 默认团队技能包内置方法，无需配置或单独安装 Superpowers。
schemaVersion: aiw.local/v1

# aiw init 会自动安装这里指定的来源；仅在团队升级时才修改 ref。
workflow:
  defaultSkillSource:
    url: https://github.com/nalanchujian/ai-workflow-skills.git
    ref: v6.0.0
  defaultProfile: standard-web-feature@6.0.0

# 只有任务来源是 Lark 文档时，才把下方示例改为实际配置。
# connectors:
#   lark:
#     # AIW 从该 Codex 配置读取 MCP Server 的启动信息。
#     configSource:
#       kind: codex-toml
#       path: ~/.codex/config.toml
#     # 与 Codex 配置中 MCP Server 的名称、读取文档工具名称保持一致。
#     server: lark
#     tool: get_document
#     # 使用 Lark UAT 环境时设为 true。
#     useUAT: false
connectors: {}
`;

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
