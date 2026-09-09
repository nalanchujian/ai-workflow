import type { ProcessRunner } from '../ports/process-runner.js';
import type { SecretStore } from '../ports/secret-store.js';

const KEYCHAIN_SERVICE = 'aiw';
const TIMEOUT_MS = 10_000;

/** macOS Keychain implementation. Values are never written to AIW configuration files. */
export class MacOsKeychainSecretStore implements SecretStore {
  constructor(private readonly deps: { processRunner: ProcessRunner; cwd: () => string }) {}

  async read(key: string): Promise<string | undefined> {
    const result = await this.run(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', key, '-w']);
    if (result.exitCode === 44) return undefined;
    if (result.exitCode !== 0 || result.timedOut) throw new Error('无法读取 macOS Keychain');
    return result.stdout.trim();
  }

  async write(key: string, value: string): Promise<void> {
    const result = await this.run(['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', key, '-w', value]);
    if (result.exitCode !== 0 || result.timedOut) throw new Error('无法写入 macOS Keychain');
  }

  async remove(key: string): Promise<void> {
    const result = await this.run(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', key]);
    if (result.exitCode !== 0 && result.exitCode !== 44) throw new Error('无法删除 macOS Keychain');
  }

  private run(args: string[]) {
    return this.deps.processRunner.run({ command: 'security', args, cwd: this.deps.cwd(), stdin: '', timeoutMs: TIMEOUT_MS });
  }
}
