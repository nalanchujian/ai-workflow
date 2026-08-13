import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse } from 'yaml';

import { ResolvedMethodSourceSchema, type MethodSource, type ResolvedMethodSource } from '../domain/method-source.js';
import type { MethodSourceResolverPort } from '../ports/method-source-resolver.js';
import { LocalConfig } from './local-config.js';
import { SkillRegistry } from './skill-registry.js';

export class MethodSourceResolver implements MethodSourceResolverPort {
  constructor(private readonly config: LocalConfig, private readonly registry?: SkillRegistry) {}

  async resolve(source: MethodSource): Promise<ResolvedMethodSource> {
    return (await this.load(source)).source;
  }

  async assertLocked(source: ResolvedMethodSource): Promise<void> {
    const resolved = await this.resolve({ id: source.id, source: source.source, version: source.version });
    if (resolved.revision !== source.revision || resolved.sha256 !== source.sha256) {
      throw new Error('方法来源内容已变化');
    }
  }

  async readLocked(source: ResolvedMethodSource): Promise<{ source: ResolvedMethodSource; content: string }> {
    const loaded = await this.load({ id: source.id, source: source.source, version: source.version });
    if (loaded.source.revision !== source.revision || loaded.source.sha256 !== source.sha256) {
      throw new Error('方法来源内容已变化');
    }
    return loaded;
  }

  private async load(source: MethodSource): Promise<{ source: ResolvedMethodSource; content: string }> {
    if (source.source.startsWith('bundled:')) {
      return this.loadBundled(source);
    }
    const match = /^configured:([a-z][a-z0-9-]*)$/.exec(source.source);
    const method = /^superpowers:([a-z][a-z0-9-]*)$/.exec(source.id);
    if (match === null || method === null) {
      throw new Error('Method source is unavailable');
    }
    const profile = await this.config.methodSource(match[1]);
    if (profile.version !== source.version) {
      throw new Error('Method source version does not match');
    }
    const root = await realpath(profile.root);
    const entry = await realpath(join(root, method[1], 'SKILL.md'));
    if (relative(root, entry).startsWith('..') || !(await lstat(entry)).isFile()) {
      throw new Error('Method source entry is invalid');
    }
    const content = (await readFile(entry)).toString('utf8');
    assertMethodName(content, method[1]);
    return {
      source: ResolvedMethodSourceSchema.parse({ ...source, revision: profile.revision, sha256: createHash('sha256').update(content).digest('hex') }),
      content,
    };
  }

  private async loadBundled(source: MethodSource): Promise<{ source: ResolvedMethodSource; content: string }> {
    if (this.registry === undefined) {
      throw new Error('Method source is unavailable');
    }
    const expected = isResolved(source) ? source : undefined;
    const candidates = (await this.registry.listMethods()).filter((method) => (
      method.source.id === source.id
      && method.source.source === source.source
      && method.source.version === source.version
      && (expected === undefined || (
        method.source.revision === expected.revision
        && method.source.sha256 === expected.sha256
      ))
    ));
    if (candidates.length === 0) {
      throw new Error(expected === undefined ? 'Method source is unavailable' : '方法来源内容已变化');
    }
    const method = candidates[0];
    return { source: method.source, content: method.content };
  }
}

function isResolved(source: MethodSource): source is ResolvedMethodSource {
  return 'revision' in source && 'sha256' in source;
}

function assertMethodName(content: string, expectedName: string): void {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (match === null) {
    throw new Error('方法来源入口缺少 front matter');
  }
  const frontMatter = parse(match[1]);
  if (frontMatter === null || typeof frontMatter !== 'object' || Array.isArray(frontMatter) || frontMatter.name !== expectedName) {
    throw new Error('方法来源入口与声明不一致');
  }
}
