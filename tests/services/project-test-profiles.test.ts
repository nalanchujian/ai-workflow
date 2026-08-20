import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ProjectTestProfiles } from '../../src/services/project-test-profiles.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

describe('ProjectTestProfiles', () => {
  it('resolves only configured test capabilities and preflights their health checks', async () => {
    const root = await createTempDirectory('aiw-test-profiles-');
    directories.push(root);
    await mkdir(join(root, '.aiw'), { recursive: true });
    await writeFile(join(root, '.aiw', 'config.yaml'), `schemaVersion: aiw.config/v1
sourceSharing:
  default: repository
  restricted: require-redacted-snapshot
testing:
  profiles:
    - id: unit
      title: 单元测试
      command: pnpm exec vitest run
      healthCheck: pnpm exec vitest --version
      targetMode: append
`, 'utf8');
    const calls: string[] = [];
    const profiles = new ProjectTestProfiles({
      processRunner: {
        async run(input) {
          calls.push([input.command, ...input.args].join(' '));
          return { exitCode: 0, signal: null, stdout: 'vitest/3', stderr: '', timedOut: false };
        },
      },
    });

    await expect(profiles.resolve(root, [{ profile: 'unit', targets: ['src/example.test.ts'] }]))
      .resolves.toEqual(['pnpm exec vitest run src/example.test.ts']);
    await expect(profiles.assertHealthy(root, [{ profile: 'unit', targets: ['src/example.test.ts'] }])).resolves.toBeUndefined();
    expect(calls).toEqual(['pnpm exec vitest --version']);
  });

  it('rejects invented profiles and reports health check failure before delivery begins', async () => {
    const root = await createTempDirectory('aiw-test-profiles-');
    directories.push(root);
    await mkdir(join(root, '.aiw'), { recursive: true });
    await writeFile(join(root, '.aiw', 'config.yaml'), `schemaVersion: aiw.config/v1
sourceSharing:
  default: repository
  restricted: require-redacted-snapshot
testing:
  profiles:
    - id: unit
      title: 单元测试
      command: pnpm exec vitest run
      healthCheck: pnpm exec vitest --version
      targetMode: append
`, 'utf8');
    const profiles = new ProjectTestProfiles({
      processRunner: { async run() { return { exitCode: 1, signal: null, stdout: '', stderr: 'runner missing', timedOut: false }; } },
    });

    await expect(profiles.resolve(root, [{ profile: 'invented', targets: [] }])).rejects.toThrow('项目未提供测试能力：invented');
    await expect(profiles.assertHealthy(root, [{ profile: 'unit', targets: [] }])).rejects.toThrow('当前不可用');
  });
});
