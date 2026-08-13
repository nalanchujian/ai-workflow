import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { packageVersion } from '../../src/cli/package-version.js';

const repositoryRoot = join(fileURLToPath(new URL('../..', import.meta.url)));

describe('packageVersion', () => {
  it('reads the installed package version instead of a source-code constant', async () => {
    const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as { version: string };

    expect(packageVersion).toBe(packageJson.version);
  });
});
