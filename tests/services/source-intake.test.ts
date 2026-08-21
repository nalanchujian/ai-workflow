import { afterEach, describe, expect, it } from 'vitest';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NetworkClient } from '../../src/ports/network-client.js';
import type { SourceConnector } from '../../src/ports/source-connector.js';
import { SourceIntake, SourceIntakeError } from '../../src/services/source-intake.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('SourceIntake', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(removeTempDirectory));
  });

  it('snapshots an explicitly selected local Markdown file without exposing artifact hashes', async () => {
    const projectRoot = await createTempDirectory('aiw-source-intake-');
    directories.push(projectRoot);
    const sourcePath = join(projectRoot, 'requirements.md');
    await writeFile(sourcePath, '# Refund\n\nAllow refunds within 30 days.\n');
    const intake = new SourceIntake({ network: safeNetwork(), projectRoot });

    const snapshot = await intake.snapshot({ sourceId: 'requirements', value: sourcePath });

    expect(snapshot.markdown).toContain('Allow refunds within 30 days.');
    expect(snapshot).not.toHaveProperty('contentSha256');
    expect(snapshot.origin).toBe('requirements.md');
  });

  it('rejects a local source outside the project before reading its content', async () => {
    const projectRoot = await createTempDirectory('aiw-source-intake-');
    const externalRoot = await createTempDirectory('aiw-external-source-');
    directories.push(projectRoot, externalRoot);
    const sourcePath = join(externalRoot, 'confidential.md');
    await writeFile(sourcePath, '# Confidential\n');
    const intake = new SourceIntake({ network: safeNetwork(), projectRoot });

    await expect(intake.snapshot({ sourceId: 'requirements', value: sourcePath }))
      .rejects.toMatchObject({ code: 'SOURCE_INVALID' } satisfies Partial<SourceIntakeError>);
  });

  it('rejects a local source passed through a symbolic link', async () => {
    const projectRoot = await createTempDirectory('aiw-source-intake-');
    const externalRoot = await createTempDirectory('aiw-external-source-');
    directories.push(projectRoot, externalRoot);
    const externalSourcePath = join(externalRoot, 'requirements.md');
    const sourcePath = join(projectRoot, 'requirements.md');
    await writeFile(externalSourcePath, '# Confidential\n');
    await symlink(externalSourcePath, sourcePath);
    const intake = new SourceIntake({ network: safeNetwork(), projectRoot });

    await expect(intake.snapshot({ sourceId: 'requirements', value: sourcePath }))
      .rejects.toMatchObject({ code: 'SOURCE_INVALID' } satisfies Partial<SourceIntakeError>);
  });

  it('rejects a URL that resolves to loopback before fetching it', async () => {
    let fetchCalls = 0;
    const network: NetworkClient = {
      async fetch() {
        fetchCalls += 1;
        return { body: 'should not be fetched', contentType: 'text/plain', url: 'http://example.test/doc' };
      },
      async resolve() {
        return ['127.0.0.1'];
      },
    };
    const intake = new SourceIntake({ network, projectRoot: '/project' });

    await expect(intake.snapshot({ sourceId: 'requirements', value: 'http://example.test/doc' }))
      .rejects.toMatchObject({ code: 'UNSAFE_URL' } satisfies Partial<SourceIntakeError>);

    expect(fetchCalls).toBe(0);
  });

  it('passes the vetted DNS addresses to the network connection', async () => {
    let received: unknown;
    const network: NetworkClient = {
      async fetch(input) {
        received = input;
        return { body: '# Requirement', contentType: 'text/markdown', url: input.url };
      },
      async resolve() {
        return ['8.8.8.8'];
      },
    };
    const intake = new SourceIntake({ network, projectRoot: '/project' });

    await intake.snapshot({ sourceId: 'requirements', value: 'https://example.test/requirements' });

    expect(received).toMatchObject({ vettedAddresses: ['8.8.8.8'] });
  });

  it('routes a document address to the matching installed connector', async () => {
    const connector: SourceConnector = {
      supports(value) { return value.startsWith('https://docs.example.test/'); },
      async fetch(input) {
        return { canonicalUrl: input, externalId: 'document-1', extractor: 'example-mcp/v1', fetchedAt: '2026-08-17T00:00:00.000Z', markdown: '# Requirement' };
      },
    };
    const intake = new SourceIntake({ connectors: [connector], network: safeNetwork(), projectRoot: '/project' });

    const snapshot = await intake.snapshot({ sourceId: 'requirements', value: 'https://docs.example.test/document-1' });

    expect(intake.classify('https://docs.example.test/document-1')).toBe('connected-document');
    expect(snapshot).toMatchObject({ kind: 'connected-document', extractor: 'example-mcp/v1' });
  });

  it('rejects section selection for a source without a matching document connector', async () => {
    const intake = new SourceIntake({ network: safeNetwork(), projectRoot: '/project' });

    await expect(intake.snapshot({ sourceId: 'requirements', value: 'https://example.test/requirements', section: '退款流程' }))
      .rejects.toMatchObject({ code: 'SOURCE_INVALID', message: '当前文档来源不支持按章节读取' } satisfies Partial<SourceIntakeError>);
  });

  it('snapshots only the selected connected document section and its child headings', async () => {
    const connector: SourceConnector = {
      supports() { return true; },
      async fetch(input) {
        return {
          canonicalUrl: input,
          externalId: 'doccn123',
          extractor: 'lark-mcp/v1',
          fetchedAt: '2026-08-13T00:00:00.000Z',
          markdown: [
            '# 总览',
            '不应包含。',
            '## 订单退款流程',
            '允许用户退款。',
            '### 例外情况',
            '管理员可以拒绝。',
            '## 发票流程',
            '不应包含。',
          ].join('\n'),
        };
      },
    };
    const intake = new SourceIntake({ connectors: [connector], network: safeNetwork(), projectRoot: '/project' });

    const snapshot = await intake.snapshot({
      sourceId: 'requirements',
      value: 'https://acme.larksuite.com/docx/doccn123',
      section: '订单退款流程',
    });

    expect(snapshot.markdown).toBe('## 订单退款流程\n允许用户退款。\n### 例外情况\n管理员可以拒绝。');
    expect(snapshot.section).toBe('订单退款流程');
  });

  it('rejects a selected section that is not unique in a connected document', async () => {
    const connector: SourceConnector = {
      supports() { return true; },
      async fetch(input) {
        return { canonicalUrl: input, externalId: 'doccn123', extractor: 'lark-mcp/v1', fetchedAt: '2026-08-13T00:00:00.000Z', markdown: '## 需求\nA\n## 需求\nB' };
      },
    };
    const intake = new SourceIntake({ connectors: [connector], network: safeNetwork(), projectRoot: '/project' });

    await expect(intake.snapshot({ sourceId: 'requirements', value: 'https://acme.larksuite.com/docx/doccn123', section: '需求' }))
      .rejects.toMatchObject({ code: 'SOURCE_INVALID', message: '需求章节不唯一：需求' } satisfies Partial<SourceIntakeError>);
  });

  it('preserves the original Wiki node and the resolved docx ID in the snapshot metadata', async () => {
    const projectRoot = await createTempDirectory('aiw-source-intake-');
    directories.push(projectRoot);
    const taskDirectory = join(projectRoot, '.aiw', 'tasks', 'task-1');
    const connector: SourceConnector = {
      supports() { return true; },
      async fetch() {
        return {
          canonicalUrl: 'https://acme.larksuite.com/wiki/wiki123',
          externalId: 'wiki123',
          resolvedExternalId: 'docx456',
          extractor: 'lark-mcp/v1',
          fetchedAt: '2026-08-13T00:00:00.000Z',
          markdown: '# 需求',
        };
      },
    };
    const intake = new SourceIntake({ connectors: [connector], network: safeNetwork(), projectRoot });

    const snapshot = await intake.snapshot({ sourceId: 'requirements', value: 'https://acme.larksuite.com/wiki/wiki123' });
    const reference = await intake.writeSnapshot({ snapshot, taskDirectory });
    const metadata = JSON.parse(await readFile(join(taskDirectory, reference.metaPath), 'utf8')) as Record<string, unknown>;

    expect(reference).toMatchObject({ externalId: 'wiki123', resolvedExternalId: 'docx456' });
    expect(metadata).toMatchObject({ externalId: 'wiki123', resolvedExternalId: 'docx456' });
  });

  it('preserves the selected document Block range in the snapshot metadata', async () => {
    const projectRoot = await createTempDirectory('aiw-source-intake-');
    directories.push(projectRoot);
    const taskDirectory = join(projectRoot, '.aiw', 'tasks', 'task-1');
    const connector: SourceConnector = {
      supports() { return true; },
      async fetch() {
        return {
          canonicalUrl: 'https://acme.larksuite.com/docx/docx456',
          externalId: 'docx456',
          extractor: 'lark-mcp/v1',
          fetchedAt: '2026-08-13T00:00:00.000Z',
          markdown: '## 二期 (V2.3)\n\n目标需求',
          section: { title: '二期 (V2.3)', startBlockId: 'block-start', endBlockId: 'block-end' },
        };
      },
    };
    const intake = new SourceIntake({ connectors: [connector], network: safeNetwork(), projectRoot });

    const snapshot = await intake.snapshot({ sourceId: 'requirements', value: 'https://acme.larksuite.com/docx/docx456', section: '二期 (V2.3)' });
    const reference = await intake.writeSnapshot({ snapshot, taskDirectory });
    const metadata = JSON.parse(await readFile(join(taskDirectory, reference.metaPath), 'utf8')) as Record<string, unknown>;

    expect(reference).toMatchObject({ sectionStartBlockId: 'block-start', sectionEndBlockId: 'block-end' });
    expect(metadata).toMatchObject({ sectionStartBlockId: 'block-start', sectionEndBlockId: 'block-end' });
  });
});

function safeNetwork(): NetworkClient {
  return {
    async fetch(input) {
      return { body: '', contentType: 'text/plain', url: input.url };
    },
    async resolve() {
      return ['8.8.8.8'];
    },
  };
}
