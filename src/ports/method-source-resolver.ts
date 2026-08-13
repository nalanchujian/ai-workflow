import type { MethodSource, ResolvedMethodSource } from '../domain/method-source.js';

export interface MethodSourceResolverPort {
  resolve(source: MethodSource): Promise<ResolvedMethodSource>;
  assertLocked(source: ResolvedMethodSource): Promise<void>;
}
