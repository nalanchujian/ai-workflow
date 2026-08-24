import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LocalConfig } from '../../src/services/local-config.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('LocalConfig', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('accepts connector-only configuration and rejects removed method-source profiles', async () => {
    const directory = await createTempDirectory('aiw-local-config-');
    directories.push(directory);
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, 'schemaVersion: aiw.local/v1\nconnectors: {}\n');

    await expect(new LocalConfig(configPath).read()).resolves.toMatchObject({ connectors: {} });
    await writeFile(configPath, 'schemaVersion: aiw.local/v1\nconnectors: {}\nmethodSources: {}\n');

    await expect(new LocalConfig(configPath).read()).rejects.toBeDefined();
  });

  it('updates the default source ref and profile together', async () => {
    const directory = await createTempDirectory('aiw-local-config-');
    directories.push(directory);
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, `schemaVersion: aiw.local/v1
connectors: {}
workflow:
  defaultSkillSource:
    url: https://github.com/nalanchujian/ai-workflow-skills.git
    ref: v2.0.0
  defaultProfile: standard-web-feature@2.0.0
`);
    const config = new LocalConfig(configPath);

    await expect(config.defaultWorkflow()).resolves.toEqual({
      defaultSkillSource: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.0.0' },
      defaultProfile: 'standard-web-feature@2.0.0',
    });

    await config.updateDefaultWorkflow({ ref: 'v2.1.0', profile: 'standard-web-feature@2.1.0' });

    await expect(config.defaultWorkflow()).resolves.toEqual({
      defaultSkillSource: { url: 'https://github.com/nalanchujian/ai-workflow-skills.git', ref: 'v2.1.0' },
      defaultProfile: 'standard-web-feature@2.1.0',
    });
  });

  it('uses the default context budget when omitted and reads an explicit override', async () => {
    const directory = await createTempDirectory('aiw-local-config-');
    directories.push(directory);
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, 'schemaVersion: aiw.local/v1\nconnectors: {}\n');
    const config = new LocalConfig(configPath);

    await expect(config.contextTokenBudget()).resolves.toBe(20_000);

    await writeFile(configPath, 'schemaVersion: aiw.local/v1\nconnectors: {}\ncontext:\n  maxTokens: 32000\n');
    await expect(config.contextTokenBudget()).resolves.toBe(32_000);
  });

  it('reads a configured read-only Figma MCP profile', async () => {
    const directory = await createTempDirectory('aiw-local-config-');
    directories.push(directory);
    const configPath = join(directory, 'config.yaml');
    await writeFile(configPath, `schemaVersion: aiw.local/v1
connectors:
  figma:
    configSource:
      kind: codex-toml
      path: ~/.codex/config.toml
    server: figma
    tools:
      metadata: get_metadata
      screenshot: get_screenshot
      designContext: get_design_context
`);

    await expect(new LocalConfig(configPath).figmaConnector()).resolves.toMatchObject({
      server: 'figma',
      tools: { metadata: 'get_metadata', screenshot: 'get_screenshot', designContext: 'get_design_context' },
    });
  });
});
