import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import type { SourceKind, SourceReference } from '../domain/task.js';
import type { NetworkClient } from '../ports/network-client.js';
import type { SourceConnector } from '../ports/source-connector.js';

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;

export interface SourceInput {
  sourceId: string;
  value: string;
  section?: string;
  revision?: number;
}

export interface SnapshotRecord {
  sourceId: string;
  kind: SourceKind;
  origin: string;
  externalId?: string;
  resolvedExternalId?: string;
  section?: string;
  sectionStartBlockId?: string;
  sectionEndBlockId?: string;
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
    private readonly deps: { connectors?: SourceConnector[]; network: NetworkClient; projectRoot: string },
  ) {}

  classify(value: string): SourceKind {
    if (this.connectorFor(value) !== undefined) return 'connected-document';
    return /^https?:\/\//.test(value) ? 'public-url' : 'local-file';
  }

  async snapshot(input: SourceInput): Promise<SnapshotRecord> {
    const connector = this.connectorFor(input.value);
    if (connector !== undefined) {
      return this.snapshotConnectedDocument(input, connector);
    }
    if (input.section !== undefined) {
      throw new SourceIntakeError('SOURCE_INVALID', '当前文档来源不支持按章节读取');
    }
    return /^https?:\/\//.test(input.value)
      ? this.snapshotPublicUrl(input)
      : this.snapshotLocalFile(input);
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
      ...(snapshot.resolvedExternalId === undefined ? {} : { resolvedExternalId: snapshot.resolvedExternalId }),
      ...(snapshot.section === undefined ? {} : { section: snapshot.section }),
      ...(snapshot.sectionStartBlockId === undefined ? {} : { sectionStartBlockId: snapshot.sectionStartBlockId }),
      ...(snapshot.sectionEndBlockId === undefined ? {} : { sectionEndBlockId: snapshot.sectionEndBlockId }),
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
      ...(snapshot.resolvedExternalId === undefined ? {} : { resolvedExternalId: snapshot.resolvedExternalId }),
      ...(snapshot.section === undefined ? {} : { section: snapshot.section }),
      ...(snapshot.sectionStartBlockId === undefined ? {} : { sectionStartBlockId: snapshot.sectionStartBlockId }),
      ...(snapshot.sectionEndBlockId === undefined ? {} : { sectionEndBlockId: snapshot.sectionEndBlockId }),
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
      const { url, addresses } = await assertSafeUrl(currentUrl, this.deps.network);
      const response = await this.deps.network.fetch({ url: url.toString(), timeoutMs: REQUEST_TIMEOUT_MS, vettedAddresses: addresses });
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

  private async snapshotConnectedDocument(input: SourceInput, connector: SourceConnector): Promise<SnapshotRecord> {
    const source = await connector.fetch(input.value, { section: input.section });
    const section = input.section === undefined ? undefined : source.section === undefined
      ? extractMarkdownSection(source.markdown, input.section)
      : { title: source.section.title, markdown: source.markdown };
    const markdown = section?.markdown ?? source.markdown;
    assertSize(markdown);
    return snapshot({
      sourceId: input.sourceId,
      kind: 'connected-document',
      origin: source.canonicalUrl,
      externalId: source.externalId,
      ...(source.resolvedExternalId === undefined ? {} : { resolvedExternalId: source.resolvedExternalId }),
      revision: input.revision ?? 1,
      markdown,
      ...(section === undefined ? {} : { section: section.title }),
      ...(source.section === undefined ? {} : { sectionStartBlockId: source.section.startBlockId, sectionEndBlockId: source.section.endBlockId }),
      extractor: source.extractor,
      fetchedAt: source.fetchedAt,
    });
  }

  private connectorFor(value: string): SourceConnector | undefined {
    return this.deps.connectors?.find((connector) => connector.supports(value));
  }
}

function extractMarkdownSection(markdown: string, requestedTitle: string): { title: string; markdown: string } {
  const requested = normalizeHeading(requestedTitle);
  if (requested.length === 0) {
    throw new SourceIntakeError('SOURCE_INVALID', '需求章节不能为空');
  }
  const lines = markdown.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    return match === null ? [] : [{ index, level: match[1].length, title: match[2].trim() }];
  });
  const matches = headings.filter((heading) => normalizeHeading(heading.title) === requested);
  if (matches.length === 0) {
    throw new SourceIntakeError('SOURCE_INVALID', `未找到需求章节：${requestedTitle.trim()}`);
  }
  if (matches.length > 1) {
    throw new SourceIntakeError('SOURCE_INVALID', `需求章节不唯一：${requestedTitle.trim()}`);
  }
  const heading = matches[0];
  const next = headings.find((candidate) => candidate.index > heading.index && candidate.level <= heading.level);
  const content = lines.slice(heading.index, next?.index).join('\n').trim();
  const body = content.replace(/^#{1,6}\s+.*(?:\r?\n|$)/, '').trim();
  if (body.length === 0) {
    throw new SourceIntakeError('SOURCE_INVALID', `需求章节为空：${heading.title}`);
  }
  return { title: heading.title, markdown: content };
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
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

async function assertSafeUrl(input: string, network: NetworkClient): Promise<{ url: URL; addresses: string[] }> {
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
  return { url, addresses };
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
