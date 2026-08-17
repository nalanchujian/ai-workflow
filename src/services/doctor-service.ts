import { DoctorResultSchema, type DoctorCheck, type DoctorResult } from '../domain/doctor.js';
import type { McpClient } from '../ports/mcp-client.js';
import type { McpServerConfigResolver } from '../ports/mcp-server-config-resolver.js';
import type { ProcessRunner } from '../ports/process-runner.js';
import type { ProjectRepository } from '../ports/project-repository.js';
import { isLarkDocumentReference, LarkSourceConnector } from './lark-source-connector.js';
import { LocalConfig, type LocalConfigDocument } from './local-config.js';
import { SkillRegistry } from './skill-registry.js';

const CHECK_TIMEOUT_MS = 10_000;
const LARK_REQUIRED_TOOLS = ['docx_v1_document_rawContent', 'docx_v1_documentBlock_list'];

export class DoctorService {
  constructor(private readonly deps: {
    config: LocalConfig;
    projectRepository: ProjectRepository;
    processRunner: ProcessRunner;
    mcpClient?: McpClient;
    mcpServerConfigResolver?: McpServerConfigResolver;
    registry?: SkillRegistry;
  }) {}

  async inspect(input: { projectRoot: string; source?: string; codexBin?: string }): Promise<DoctorResult> {
    const checks: DoctorCheck[] = [
      await this.executableCheck('git-cli', 'Git CLI', 'git', ['--version'], input.projectRoot, '安装 Git，并确保 `git --version` 可执行。'),
      await this.projectCheck(input.projectRoot),
      await this.executableCheck('codex-cli', 'Codex CLI', input.codexBin ?? process.env.AIW_CODEX_BIN ?? 'codex', ['--version'], input.projectRoot, '安装并登录 Codex CLI，或设置 `AIW_CODEX_BIN`。'),
    ];

    let config: LocalConfigDocument | undefined;
    try {
      config = await this.deps.config.read();
      checks.push(passed('local-configuration', '本机配置', '本机配置格式有效。'));
    } catch {
      checks.push(failed('local-configuration', '本机配置', '无法读取或校验本机配置。', '检查并修复 `~/.aiw/config.yaml`，然后重新运行 `aiw doctor`。'));
    }

    if (config === undefined) {
      checks.push(warning('method-sources', '方法来源', '未检查内置方法，因为本机配置无效。', '运行 `aiw init` 重新创建或修复 `~/.aiw/config.yaml`。'));
      const connectorSource = larkSource(input.source);
      checks.push(connectorSource === undefined
        ? warning('document-connector-configuration', '文档连接器配置', '未检查文档连接器配置，因为本机配置无效。', '先修复 `~/.aiw/config.yaml` 中的文档连接器配置。')
        : failed('document-connector-configuration', '文档连接器配置', '无法验证指定文档，因为本机配置无效。', '先修复 `~/.aiw/config.yaml` 中的文档连接器配置。'));
      checks.push(warning('document-authorization', '文档读取授权', '未验证，因为本机配置无效。', '修复配置后运行 `aiw doctor --source <文档地址>`。'));
      return result(checks);
    }

    checks.push(...await this.methodSourceChecks(config));
    checks.push(...await this.larkChecks(config, larkSource(input.source)));
    return result(checks);
  }

  private async executableCheck(id: string, label: string, command: string, args: string[], cwd: string, suggestion: string): Promise<DoctorCheck> {
    try {
      const output = await this.deps.processRunner.run({ command, args, cwd, stdin: '', timeoutMs: CHECK_TIMEOUT_MS });
      if (output.exitCode === 0 && output.signal === null && !output.timedOut) {
        return passed(id, label, '可执行。');
      }
    } catch {
      // Diagnostics must continue after a missing executable or process failure.
    }
    return failed(id, label, '不可执行或检查超时。', suggestion);
  }

  private async projectCheck(projectRoot: string): Promise<DoctorCheck> {
    try {
      await this.deps.projectRepository.assertProjectReady(projectRoot);
      return passed('project-repository', '项目 Git 状态', '项目是 Git 工作树，且 `.aiw/` 可以提交。');
    } catch {
      return failed('project-repository', '项目 Git 状态', '项目不是可用的 Git 工作树，或 `.aiw/` 被忽略。', '在业务仓库中运行命令，并确保 `.gitignore` 未忽略 `.aiw/`。');
    }
  }

  private async methodSourceChecks(config: LocalConfigDocument): Promise<DoctorCheck[]> {
    void config;
    const bundledMethods = await this.deps.registry?.listMethods() ?? [];
    return bundledMethods.length === 0
      ? [warning('method-sources', '方法来源', '尚未安装内置方法。', '运行 `aiw skills install <team-skill-repository>` 安装团队技能包。')]
      : [passed('method-sources', '方法来源', `已安装 ${bundledMethods.length} 个由团队技能包锁定的内置方法。`)];
  }

  private async larkChecks(config: LocalConfigDocument, source: string | undefined): Promise<DoctorCheck[]> {
    const profile = config.connectors.lark;
    if (profile === undefined) {
      return [
        source === undefined
          ? warning('document-connector-configuration', '文档连接器配置', '未配置可用的文档连接器。', '如需读取在线文档，在 `~/.aiw/config.yaml` 配置对应的文档连接器。')
          : failed('document-connector-configuration', '文档连接器配置', '未配置可读取该文档的连接器，无法验证指定文档。', '在 `~/.aiw/config.yaml` 配置对应的文档连接器。'),
        warning('document-authorization', '文档读取授权', '未验证。', '配置文档连接器后运行 `aiw doctor --source <文档地址>`。'),
      ];
    }
    if (this.deps.mcpServerConfigResolver === undefined || this.deps.mcpClient === undefined) {
      return [
        failed('document-connector-configuration', '文档连接器配置', '当前运行环境未提供 MCP 调用能力。', '使用完整的 aiw CLI 运行 `aiw doctor`。'),
        warning('document-authorization', '文档读取授权', '未验证。', '修复 MCP 调用环境后运行 `aiw doctor --source <文档地址>`。'),
      ];
    }
    let server: Awaited<ReturnType<McpServerConfigResolver['resolve']>>;
    try {
      server = await this.deps.mcpServerConfigResolver.resolve({ source: profile.configSource.kind, path: profile.configSource.path, server: profile.server });
    } catch {
      return [
        failed('document-connector-configuration', '文档连接器配置', '无法解析已配置的文档 MCP Server。', '检查本机文档连接器配置和 Codex TOML 中对应的 MCP Server 定义。'),
        warning('document-authorization', '文档读取授权', '未验证。', '修复 MCP 配置后运行 `aiw doctor --source <文档地址>`。'),
      ];
    }
    try {
      if (this.deps.mcpClient.listTools === undefined) {
        throw new Error('MCP 不支持工具清单');
      }
      const available = new Set((await this.deps.mcpClient.listTools({ server })).map((tool) => tool.name));
      const missing = LARK_REQUIRED_TOOLS.filter((tool) => !available.has(tool));
      if (missing.length > 0) {
        return [
          failed('document-connector-configuration', '文档连接器配置', `缺少章节读取工具：${missing.join('、')}。`, '为当前文档 MCP 启用正文读取与章节读取工具后重新运行 `aiw doctor`。'),
          warning('document-authorization', '文档读取授权', '未验证。', '修复 MCP 工具配置后运行 `aiw doctor --source <文档地址>`。'),
        ];
      }
    } catch {
      return [
        failed('document-connector-configuration', '文档连接器配置', '无法读取文档 MCP 工具清单。', '确认文档 MCP 可启动并启用正文和章节读取工具。'),
        warning('document-authorization', '文档读取授权', '未验证。', '修复 MCP 工具配置后运行 `aiw doctor --source <文档地址>`。'),
      ];
    }
    if (source === undefined) {
      return [
        passed('document-connector-configuration', '文档连接器配置', 'Connector Profile 与 MCP Server 定义可解析。'),
        warning('document-authorization', '文档读取授权', '未验证。', '运行 `aiw doctor --source <文档地址>` 验证文档读取权限。'),
      ];
    }
    try {
      const connector = new LarkSourceConnector({
        client: this.deps.mcpClient,
        resolver: this.deps.mcpServerConfigResolver,
        config: { configPath: profile.configSource.path, server: profile.server, tool: profile.tool, useUAT: profile.useUAT },
      });
      await connector.fetch(source);
      return [
        passed('document-connector-configuration', '文档连接器配置', 'Connector Profile 与 MCP Server 定义可解析。'),
        passed('document-authorization', '文档读取授权', '指定文档可通过已配置连接器读取。'),
      ];
    } catch {
      return [
        passed('document-connector-configuration', '文档连接器配置', 'Connector Profile 与 MCP Server 定义可解析。'),
        failed('document-authorization', '文档读取授权', '无法通过已配置连接器读取指定文档。', '确认文档地址、连接器授权和当前账号权限后重试。'),
      ];
    }
  }
}

function larkSource(source: string | undefined): string | undefined {
  return source !== undefined && isLarkDocumentReference(source) ? source : undefined;
}

function result(checks: DoctorCheck[]): DoctorResult {
  return DoctorResultSchema.parse({ schemaVersion: 'aiw.doctor/v1', ok: !checks.some((check) => check.status === 'failed'), checks });
}

function passed(id: string, label: string, message: string): DoctorCheck {
  return { id, label, status: 'passed', message };
}

function warning(id: string, label: string, message: string, suggestion: string): DoctorCheck {
  return { id, label, status: 'warning', message, suggestion };
}

function failed(id: string, label: string, message: string, suggestion: string): DoctorCheck {
  return { id, label, status: 'failed', message, suggestion };
}
