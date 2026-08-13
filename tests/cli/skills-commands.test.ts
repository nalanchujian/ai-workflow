import { describe, expect, it } from 'vitest';

import { createSkillsCommand } from '../../src/cli/skills-commands.js';

describe('skills commands', () => {
  it('lists installed workflow profiles', async () => {
    let output = '';
    const command = createSkillsCommand({
      installer: {} as never,
      registry: { async list() { return []; }, async listProfiles() { return [{ name: 'standard-web-feature', version: '1.0.0' }]; } } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'skills', 'profiles', 'list']);

    expect(output).toContain('standard-web-feature');
  });
});
