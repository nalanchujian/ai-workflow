import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/run-cli.js';

describe('aiw CLI help', () => {
  it('prints the top-level command groups for --help', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('skills');
    expect(result.stdout).toContain('task');
  });
});
