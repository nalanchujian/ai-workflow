import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LocalInitializer } from '../../src/services/local-initializer.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('LocalInitializer', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

  it('creates a documented connector and default-workflow template without overwriting it', async () => {
    const directory = await createTempDirectory('aiw-local-init-');
    directories.push(directory);
    const initializer = new LocalInitializer(join(directory, 'config.yaml'));

    await expect(initializer.init()).resolves.toEqual({ schemaVersion: 'aiw.init/v1', status: 'created', configPath: join(directory, 'config.yaml') });
    await expect(readFile(join(directory, 'config.yaml'), 'utf8')).resolves.toContain('connectors: {}');
    await expect(readFile(join(directory, 'config.yaml'), 'utf8')).resolves.toContain('ref: v0.0.9');
    await expect(readFile(join(directory, 'config.yaml'), 'utf8')).resolves.toContain('defaultProfile: standard-web-feature');
    await expect(readFile(join(directory, 'config.yaml'), 'utf8')).resolves.not.toContain('standard-web-feature@');
    await expect(readFile(join(directory, 'config.yaml'), 'utf8')).resolves.toContain('maxTokens: 20000');
    await expect(readFile(join(directory, 'config.yaml'), 'utf8')).resolves.not.toContain('methodSources:');
    await expect(initializer.init()).resolves.toEqual({ schemaVersion: 'aiw.init/v1', status: 'already-initialized', configPath: join(directory, 'config.yaml') });
  });

  it('updates an existing official workflow ref while preserving user settings', async () => {
    const directory = await createTempDirectory('aiw-local-init-');
    directories.push(directory);
    const path = join(directory, 'config.yaml');
    await writeFile(path, `schemaVersion: aiw.local/v1
workflow:
  defaultSkillSource:
    url: https://github.com/nalanchujian/ai-workflow-skills.git
    ref: v0.0.2
  defaultProfile: standard-web-feature@0.0.1
context:
  maxTokens: 30000
connectors:
  lark:
    configSource:
      kind: codex-toml
      path: ~/.codex/config.toml
    server: lark-openapi
    tool: docx_v1_document_rawContent
    useUAT: false
`, 'utf8');
    const initializer = new LocalInitializer(path);

    await expect(initializer.init()).resolves.toEqual({ schemaVersion: 'aiw.init/v1', status: 'updated', configPath: path });
    const updated = await readFile(path, 'utf8');
    expect(updated).toContain('ref: v0.0.9');
    expect(updated).toContain('defaultProfile: standard-web-feature');
    expect(updated).not.toContain('standard-web-feature@');
    expect(updated).toContain('maxTokens: 30000');
    expect(updated).toContain('server: lark-openapi');
  });
});
