import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import type { SourceKind, SourceReference } from '../domain/task.js';
import type { NetworkClient } from '../ports/network-client.js';
import type { SourceConnector } from './lark-source-connector.js';

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;

export interface SourceInput {
  kind: SourceKind;
  sourceId: string;
  value: string;
  revision?: number;
}

export interface SnapshotRecord {
  sourceId: string;
  kind: SourceKind;
  origin: string;
  externalId?: string;
  revision: number;
  fetchedAt: string;
  markdown: string;
  contentSha256: string;
  extractor: string;
}

export class SourceIntakeError extends Error {
  constructor(readonly code: 'UNSAFE_URL' | 'SOURCE_INVALID' | 'SOURCE_TOO_LARGE' | 'SOURCE_UNSUPPORTED', message: string) {
    super(message);
    this.name = 'SourceIntakeError';
  }
}

export class SourceIntake {
  constructor(
    private readonly deps: { connector?: SourceConnector; network: NetworkClient; projectRoot: string },
  ) {}

  async snapshot(input: SourceInput): Promise<SnapshotRecord> {
    switch (input.kind) {
      case 'local-file':
        return this.snapshotLocalFile(input);
      case 'public-url':
        return this.snapshotPublicUrl(input);
      case 'lark-document':
        return this.snapshotLarkDocument(input);
    }
  }

  async writeSnapshot(input: { snapshot: SnapshotRecord; taskDirectory: string }): Promise<SourceReference> {
    const { snapshot, taskDirectory } = input;
    const revisionDirectory = join(taskDirectory, 'sources', snapshot.sourceId, `r${snapshot.revision}`);
    await mkdir(revisionDirectory, { recursive: true });
    const snapshotPath = join(revisionDirectory, 'snapshot.md');
    const metaPath = join(revisionDirectory, 'meta.json');
    const meta = {
      sourceId: snapshot.sourceId,
      kind: snapshot.kind,
      origin: snapshot.origin,
      ...(snapshot.externalId === undefined ? {} : { externalId: snapshot.externalId }),
      revision: snapshot.revision,
      fetchedAt: snapshot.fetchedAt,
      contentSha256: snapshot.contentSha256,
      extractor: snapshot.extractor,
    };
    await writeFile(snapshotPath, snapshot.markdown, 'utf8');
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    return {
      kind: snapshot.kind,
      origin: snapshot.origin,
      ...(snapshot.externalId === undefined ? {} : { externalId: snapshot.externalId }),
      revision: snapshot.revision,
      snapshotPath: relative(taskDirectory, snapshotPath).replaceAll('\\', '/'),
      metaPath: relative(taskDirectory, metaPath).replaceAll('\\', '/'),
      contentSha256: snapshot.contentSha256,
    };
  }

  private async snapshotLocalFile(input: SourceInput): Promise<SnapshotRecord> {
    let sourcePath: string;
    let projectRoot: string;
    try {
      const sourceEntry = await lstat(input.value);
      if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink()) {
        throw new SourceIntakeError('SOURCE_INVALID', '本地来源必须是普通文件');
      }
      sourcePath = await realpath(input.value);
      projectRoot = await realpath(this.deps.projectRoot).catch(() => resolve(this.deps.projectRoot));
      if (!isWithinDirectory(projectRoot, sourcePath)) {
        throw new SourceIntakeError('SOURCE_INVALID', '本地来源必须位于项目目录内');
      }
    } catch (error) {
      if (error instanceof SourceIntakeError) {
        throw error;
      }
      throw new SourceIntakeError('SOURCE_INVALID', '无法读取本地来源文件');
    }
    const markdown = await readSourceText(sourcePath);
    const sourceRelativePath = relative(projectRoot, sourcePath);
    return snapshot({
      sourceId: input.sourceId,
      kind: 'local-file',
      origin: sourceRelativePath.replaceAll('\\', '/'),
      revision: input.revision ?? 1,
      markdown,
      extractor: `local-file/${basename(sourcePath)}`,
    });
  }

  private async snapshotPublicUrl(input: SourceInput): Promise<SnapshotRecord> {
    let currentUrl = input.value;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const url = await assertSafeUrl(currentUrl, this.deps.network);
      const response = await this.deps.network.fetch({ url: url.toString(), timeoutMs: REQUEST_TIMEOUT_MS });
      if (response.location !== undefined && response.status !== undefined && response.status >= 300 && response.status < 400) {
        currentUrl = new URL(response.location, url).toString();
        continue;
      }
      if (!['text/plain', 'text/markdown', 'text/html'].includes(response.contentType.split(';')[0].trim().toLowerCase())) {
        throw new SourceIntakeError('SOURCE_UNSUPPORTED', '不支持的来源内容类型');
      }
      assertSize(response.body);
      return snapshot({
        sourceId: input.sourceId,
        kind: 'public-url',
        origin: response.url,
        revision: input.revision ?? 1,
        markdown: response.contentType.startsWith('text/html') ? htmlToText(response.body) : response.body,
        extractor: response.contentType.startsWith('text/html') ? 'html-to-markdown/v1' : 'plain-text/v1',
      });
    }
    throw new SourceIntakeError('UNSAFE_URL', 'URL 重定向次数超限');
  }

  private async snapshotLarkDocument(input: SourceInput): Promise<SnapshotRecord> {
    if (this.deps.connector === undefined || !this.deps.connector.supports(input.value)) {
      throw new SourceIntakeError('SOURCE_UNSUPPORTED', '当前 Connector 不支持该文档类型');
    }
    const source = await this.deps.connector.fetch(input.value);
    assertSize(source.markdown);
    return snapshot({
      sourceId: input.sourceId,
      kind: 'lark-document',
      origin: source.canonicalUrl,
      externalId: source.externalId,
      revision: input.revision ?? 1,
      markdown: source.markdown,
      extractor: source.extractor,
      fetchedAt: source.fetchedAt,
    });
  }
}

function isWithinDirectory(directory: string, target: string): boolean {
  const path = relative(directory, target);
  return path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path);
}

function snapshot(input: Omit<SnapshotRecord, 'contentSha256' | 'fetchedAt'> & { fetchedAt?: string }): SnapshotRecord {
  assertSize(input.markdown);
  return {
    ...input,
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    contentSha256: createHash('sha256').update(input.markdown, 'utf8').digest('hex'),
  };
}

async function readSourceText(path: string): Promise<string> {
  const content = await readFile(path, 'utf8');
  assertSize(content);
  return content;
}

function assertSize(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) {
    throw new SourceIntakeError('SOURCE_TOO_LARGE', '来源内容超过大小上限');
  }
}

async function assertSafeUrl(input: string, network: NetworkClient): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SourceIntakeError('UNSAFE_URL', '无效 URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    (url.port !== '' && !((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')))
  ) {
    throw new SourceIntakeError('UNSAFE_URL', 'URL 不符合安全策略');
  }
  const addresses = await network.resolve(url.hostname);
  if (addresses.length === 0 || addresses.some(isUnsafeAddress)) {
    throw new SourceIntakeError('UNSAFE_URL', 'URL 解析到了不安全地址');
  }
  return url;
}

function isUnsafeAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [first, second] = address.split('.').map(Number);
    return first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127) ||
      (first === 192 && second === 0) || first >= 240;
  }
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

function htmlToText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
