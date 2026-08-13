import type { MethodSource, ResolvedMethodSource } from '../domain/method-source.js';
import type { MethodSourceResolverPort } from '../ports/method-source-resolver.js';
import { SkillRegistry } from './skill-registry.js';

export class MethodSourceResolver implements MethodSourceResolverPort {
  constructor(private readonly registry: SkillRegistry) {}

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
    if (!source.source.startsWith('bundled:')) {
      throw new Error('Method source is unavailable');
    }
    return this.loadBundled(source);
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
