import { describe, expect, it } from 'vitest';

import { renderHumanOutput, writeResult } from '../../src/cli/output.js';

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

  it('numbers every next step in human-readable output', () => {
    expect(renderHumanOutput({ headline: '任务已更新', nextSteps: ['先提交任务事实', '再运行 plan 节点'] }))
      .toContain('下一步：\n1. 先提交任务事实\n2. 再运行 plan 节点');
  });
});
