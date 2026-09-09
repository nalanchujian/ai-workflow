import { DoctorResultSchema, type DoctorCheck, type DoctorResult } from '../domain/doctor.js';
import type { ProcessRunner } from '../ports/process-runner.js';
import type { ProjectRepository } from '../ports/project-repository.js';
import type { SourceConnector } from '../ports/source-connector.js';
import { isLarkDocumentReference, LarkSourceConnectorError } from './lark-source-connector.js';
import { LocalConfig, type LocalConfigDocument } from './local-config.js';

const CHECK_TIMEOUT_MS = 10_000;
export class DoctorService {
  constructor(private readonly deps: {
    config: LocalConfig;
    projectRepository: ProjectRepository;
    processRunner: ProcessRunner;
    connector: SourceConnector;
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
      checks.push(passed('local-configuration', 'AIW 本机设置', '默认工作流和文档连接器设置有效。'));
    } catch {
      checks.push(failed('local-configuration', 'AIW 本机设置', '无法读取或校验 AIW 本机设置。', '检查并修复 `~/.aiw/config.yaml`，然后重新运行 `aiw doctor`。'));
    }

    if (config === undefined) {
      const connectorSource = larkSource(input.source);
      checks.push(connectorSource === undefined
        ? warning('document-connector-configuration', '文档连接器配置', '未检查文档连接器配置，因为本机配置无效。', '先修复 `~/.aiw/config.yaml` 中的文档连接器配置。')
        : failed('document-connector-configuration', '文档连接器配置', '无法验证指定文档，因为本机配置无效。', '先修复 `~/.aiw/config.yaml` 中的文档连接器配置。'));
      checks.push(warning('document-authorization', '文档读取授权', '未验证，因为本机配置无效。', '修复配置后运行 `aiw doctor --source <文档地址>`。'));
      return result(checks);
    }

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
    if (source === undefined) {
      return [
        passed('document-connector-configuration', '文档连接器配置', 'Lark MCP 用户身份配置有效。'),
        warning('document-authorization', '文档读取授权', '未验证。', '运行 `aiw doctor --source <文档地址>` 验证用户身份文档读取权限。'),
      ];
    }
    try {
      await this.deps.connector.fetch(source);
      return [
        passed('document-connector-configuration', '文档连接器配置', 'Lark MCP 用户身份配置有效。'),
        passed('document-authorization', '文档读取授权', '指定文档可通过用户身份读取。'),
      ];
    } catch (error) {
      if (error instanceof LarkSourceConnectorError && (error.code === 'LARK_AUTH_EXPIRED' || error.code === 'LARK_AUTHORIZATION_DENIED')) {
        return [
          passed('document-connector-configuration', '文档连接器配置', 'Lark MCP 用户身份配置有效。'),
          failed('document-authorization', '文档读取授权', error.message, '重新完成 Lark OAuth 授权后重试。'),
        ];
      }
      return [
        passed('document-connector-configuration', '文档连接器配置', 'Lark MCP 用户身份配置有效。'),
        failed('document-authorization', '文档读取授权', '无法通过 Lark MCP 用户身份读取指定文档。', '确认 MCP 登录状态和用户对文档的访问权限后重试。'),
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
