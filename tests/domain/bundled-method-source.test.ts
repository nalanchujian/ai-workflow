import { describe, expect, it } from 'vitest';

import { BundledMethodManifestSchema, InstalledBundledMethodSchema } from '../../src/domain/bundled-method-source.js';

describe('bundled method source schemas', () => {
  it('accepts a verified bundled method and its upstream manifest', () => {
    expect(BundledMethodManifestSchema.parse({
      id: 'superpowers',
      version: '6.2.0',
      upstream: { url: 'https://github.com/obra/superpowers.git', revision: 'a'.repeat(40), license: 'MIT' },
      methods: ['brainstorming'],
    })).toMatchObject({ id: 'superpowers', version: '6.2.0' });
    expect(InstalledBundledMethodSchema.parse({
      source: { id: 'superpowers:brainstorming', source: 'bundled:superpowers', version: '6.2.0', revision: 'a'.repeat(40), sha256: 'b'.repeat(64) },
      content: '---\nname: brainstorming\n---\n\n# Brainstorming\n',
      registrySource: { url: 'https://example.test/skills.git', revision: 'c'.repeat(40) },
    }).source.source).toBe('bundled:superpowers');
  });
});
