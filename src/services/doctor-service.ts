import { DoctorResultSchema, type DoctorCheck, type DoctorResult } from '../domain/doctor.js';
import type { McpClient } from '../ports/mcp-client.js';
import type { McpServerConfigResolver } from '../ports/mcp-server-config-resolver.js';
import type { ProcessRunner } from '../ports/process-runner.js';
import type { ProjectRepository } from '../ports/project-repository.js';
import { LarkSourceConnector } from './lark-source-connector.js';
import { LocalConfig, type LocalConfigDocument } from './local-config.js';
import { SkillRegistry } from './skill-registry.js';

const CHECK_TIMEOUT_MS = 10_000;

export class DoctorService {
  constructor(private readonly deps: {
    config: LocalConfig;
    projectRepository: ProjectRepository;
    processRunner: ProcessRunner;
    mcpClient?: McpClient;
    mcpServerConfigResolver?: McpServerConfigResolver;
    registry?: SkillRegistry;
  }) {}

  async inspect(input: { projectRoot: string; larkUrl?: string; codexBin?: string }): Promise<DoctorResult> {
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
      checks.push(input.larkUrl === undefined
        ? warning('lark-configuration', 'Lark MCP 配置', '未检查 Lark MCP 配置，因为本机配置无效。', '先修复 `~/.aiw/config.yaml` 中的 `connectors.lark` 配置。')
        : failed('lark-configuration', 'Lark MCP 配置', '无法验证指定 Lark 文档，因为本机配置无效。', '先修复 `~/.aiw/config.yaml` 中的 `connectors.lark` 配置。'));
      checks.push(warning('lark-authorization', 'Lark 授权', '未验证，因为本机配置无效。', '修复配置后运行 `aiw doctor --lark-url <lark-url>`。'));
      return result(checks);
    }

    checks.push(...await this.methodSourceChecks(config));
    checks.push(...await this.larkChecks(config, input.larkUrl));
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

  private async larkChecks(config: LocalConfigDocument, larkUrl: string | undefined): Promise<DoctorCheck[]> {
    const profile = config.connectors.lark;
    if (profile === undefined) {
      return [
        larkUrl === undefined
          ? warning('lark-configuration', 'Lark MCP 配置', '未配置 Lark Connector。', '如需读取 Lark 文档，在 `~/.aiw/config.yaml` 配置 `connectors.lark`。')
          : failed('lark-configuration', 'Lark MCP 配置', '未配置 Lark Connector，无法验证指定文档。', '在 `~/.aiw/config.yaml` 配置 `connectors.lark`。'),
        warning('lark-authorization', 'Lark 授权', '未验证。', '配置 Lark Connector 后运行 `aiw doctor --lark-url <lark-url>`。'),
      ];
    }
    if (this.deps.mcpServerConfigResolver === undefined || this.deps.mcpClient === undefined) {
      return [
        failed('lark-configuration', 'Lark MCP 配置', '当前运行环境未提供 MCP 调用能力。', '使用完整的 aiw CLI 运行 `aiw doctor`。'),
        warning('lark-authorization', 'Lark 授权', '未验证。', '修复 MCP 调用环境后运行 `aiw doctor --lark-url <lark-url>`。'),
      ];
    }
    try {
      await this.deps.mcpServerConfigResolver.resolve({ source: profile.configSource.kind, path: profile.configSource.path, server: profile.server });
    } catch {
      return [
        failed('lark-configuration', 'Lark MCP 配置', '无法解析指定的 MCP Server。', '检查 `connectors.lark` 和 Codex TOML 中对应的 MCP Server 定义。'),
        warning('lark-authorization', 'Lark 授权', '未验证。', '修复 MCP 配置后运行 `aiw doctor --lark-url <lark-url>`。'),
      ];
    }
    if (larkUrl === undefined) {
      return [
        passed('lark-configuration', 'Lark MCP 配置', 'Connector Profile 与 MCP Server 定义可解析。'),
        warning('lark-authorization', 'Lark 授权', '未验证。', '运行 `aiw doctor --lark-url <lark-url>` 验证文档读取权限。'),
      ];
    }
    try {
      const connector = new LarkSourceConnector({
        client: this.deps.mcpClient,
        resolver: this.deps.mcpServerConfigResolver,
        config: { configPath: profile.configSource.path, server: profile.server, tool: profile.tool, useUAT: profile.useUAT },
      });
      await connector.fetch(larkUrl);
      return [
        passed('lark-configuration', 'Lark MCP 配置', 'Connector Profile 与 MCP Server 定义可解析。'),
        passed('lark-authorization', 'Lark 授权', '指定文档可通过 Lark MCP 读取。'),
      ];
    } catch {
      return [
        passed('lark-configuration', 'Lark MCP 配置', 'Connector Profile 与 MCP Server 定义可解析。'),
        failed('lark-authorization', 'Lark 授权', '无法通过 Lark MCP 读取指定文档。', '确认该文档 URL、Lark 应用授权和当前账号权限后重试。'),
      ];
    }
  }
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
