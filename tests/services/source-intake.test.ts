import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NetworkClient } from '../../src/ports/network-client.js';
import { SourceIntake, SourceIntakeError } from '../../src/services/source-intake.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

describe('SourceIntake', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(removeTempDirectory));
  });

  it('hashes an explicitly selected local Markdown file', async () => {
    const projectRoot = await createTempDirectory('aiw-source-intake-');
    directories.push(projectRoot);
    const sourcePath = join(projectRoot, 'requirements.md');
    await writeFile(sourcePath, '# Refund\n\nAllow refunds within 30 days.\n');
    const intake = new SourceIntake({ network: safeNetwork(), projectRoot });

    const snapshot = await intake.snapshot({ kind: 'local-file', sourceId: 'requirements', value: sourcePath });

    expect(snapshot.markdown).toContain('Allow refunds within 30 days.');
    expect(snapshot.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.origin).toBe('requirements.md');
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

    await expect(intake.snapshot({ kind: 'public-url', sourceId: 'requirements', value: 'http://example.test/doc' }))
      .rejects.toMatchObject({ code: 'UNSAFE_URL' } satisfies Partial<SourceIntakeError>);

    expect(fetchCalls).toBe(0);
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
