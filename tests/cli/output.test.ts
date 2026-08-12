import { describe, expect, it } from 'vitest';

import { writeResult } from '../../src/cli/output.js';

describe('CLI output', () => {
  it('writes exactly one JSON document when JSON output is selected', () => {
    let text = '';
    const stdout = {
      write(chunk: string) {
        text += chunk;
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    writeResult({ taskId: 'refund-123' }, { json: true, stdout });

    expect(text).toBe('{"taskId":"refund-123"}\n');
  });
});
