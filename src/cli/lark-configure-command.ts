import { Command } from 'commander';

import type { LarkAppCredentialService } from '../services/lark-app-credential-service.js';
import { LocalConfig } from '../services/local-config.js';
import { writeCommandResult } from './output.js';
import { TerminalProgressReporter, withProgress, type ProgressReporter } from './progress-reporter.js';

export function createLarkConfigureCommand(deps: { config: LocalConfig; credentials: LarkAppCredentialService; progress?: ProgressReporter; stdout: NodeJS.WriteStream }): Command {
  return new Command('configure')
    .description('配置 AIW 读取 Lark 文档所需的应用凭据')
    .requiredOption('--app-id <app-id>', 'Lark 应用 App ID')
    .requiredOption('--app-secret <app-secret>', 'Lark 应用 App Secret，只写入 macOS Keychain')
    .option('--domain <domain>', 'Lark OpenAPI 域名', 'https://open.larksuite.com')
    .option('--callback-host <host>', '本地 OAuth 回调主机', '127.0.0.1')
    .option('--callback-port <port>', '本地 OAuth 回调端口', '38991')
    .action(async (options: { appId: string; appSecret: string; domain: string; callbackHost: string; callbackPort: string }, command: Command) => {
      const callbackPort = Number(options.callbackPort);
      if (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65_535) throw new Error('OAuth 回调端口必须是 1 到 65535 的整数');
      const result = await withProgress({
        reporter: deps.progress ?? new TerminalProgressReporter({ stderr: process.stderr }),
        command,
        start: '正在配置 Lark 用户身份读取',
        success: 'Lark 用户身份读取配置完成',
        failure: 'Lark 用户身份读取配置失败',
        operation: async () => {
          const domain = normalizeDomain(options.domain);
          await deps.config.updateLarkConnector({ appId: options.appId.trim(), domain, callback: { host: options.callbackHost.trim(), port: callbackPort } });
          await deps.credentials.saveAppSecret(options.appSecret);
          return { callbackUrl: `http://${options.callbackHost.trim()}:${callbackPort}/callback` };
        },
      });
      writeCommandResult(result, command, deps.stdout, {
        headline: 'Lark 用户身份读取已配置',
        sections: [{ title: '配置结果', lines: [`回调地址：${result.callbackUrl}`, 'App Secret 已保存到 macOS Keychain。每次读取 Lark 文档时都会重新打开浏览器授权。'] }],
        nextSteps: ['aiw doctor --source <Lark 文档地址>'],
      });
    });
}

function normalizeDomain(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('invalid');
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error('Lark 域名必须是 HTTPS 地址');
  }
}
