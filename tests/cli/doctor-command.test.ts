import { describe, expect, it } from 'vitest';

import { createDoctorCommand } from '../../src/cli/doctor-command.js';

describe('doctor command', () => {
  it('forwards the optional project and Lark URL without emitting the document content', async () => {
    let received: unknown;
    let output = '';
    const command = createDoctorCommand({
      doctor: {
        async inspect(input: unknown) {
          received = input;
          return { schemaVersion: 'aiw.doctor/v1', ok: true, checks: [] };
        },
      } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'doctor', '--project', '/repo', '--lark-url', 'https://acme.larksuite.com/docx/doccn123']);

    expect(received).toEqual({ projectRoot: '/repo', larkUrl: 'https://acme.larksuite.com/docx/doccn123' });
    expect(output).toContain('"ok": true');
    expect(output).not.toContain('requirements');
  });
});
