import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(fileURLToPath(new URL('..', import.meta.url)));

describe('public npm distribution metadata', () => {
  it('declares the public package, CLI entry, release gate, and package whitelist', async () => {
    const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as {
      name: string;
      private: boolean;
      bin: Record<string, string>;
      files: string[];
      publishConfig: { access: string; registry: string };
      scripts: Record<string, string>;
    };

    expect(packageJson.name).toBe('@nalanchujian/ai-workflow');
    expect(packageJson.private).toBe(false);
    expect(packageJson.bin).toEqual({ aiw: './dist/cli.js' });
    expect(packageJson.files).toEqual(['dist', 'README.md']);
    expect(packageJson.publishConfig).toEqual({ access: 'public', registry: 'https://registry.npmjs.org' });
    expect(packageJson.scripts.prepublishOnly).toBe('pnpm lint && pnpm typecheck && pnpm test && pnpm build');
    expect(packageJson.scripts['pack:check']).toBe('pnpm build && npm pack --dry-run');
    expect(packageJson.scripts['publish:public']).toBe('node scripts/assert-release-ready.mjs && npm publish --access public --registry=https://registry.npmjs.org && node scripts/commit-published-package.mjs');
    expect(packageJson.scripts['release:patch']).toBe('node scripts/assert-release-clean.mjs && pnpm version patch --no-git-tag-version && pnpm publish:public');
  });
});
