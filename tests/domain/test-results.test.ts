import { describe, expect, it } from 'vitest';

import { TestResultsSchema } from '../../src/domain/test-results.js';

describe('TestResultsSchema', () => {
  it('requires a passing test to record exit code zero', () => {
    expect(() => TestResultsSchema.parse({
      schemaVersion: 'aiw.test-results/v2',
      runId: 'run-1',
      items: [{ id: 'TEST-LIST-01', profile: 'vitest', evidenceType: 'unit', acceptanceRefs: ['AC-01'], command: 'pnpm test -- list', status: 'passed', exitCode: 1, summary: '列表测试已执行但命令失败。', evidencePath: 'runs/run-1/tests/TEST-LIST-01.json', evidenceSha256: 'a'.repeat(64) }],
    })).toThrow('通过的测试必须记录退出码 0');
  });

  it('rejects a fabricated exit code for a blocked test', () => {
    expect(() => TestResultsSchema.parse({
      schemaVersion: 'aiw.test-results/v2',
      runId: 'run-1',
      items: [{ id: 'TEST-LIST-01', profile: 'vitest', evidenceType: 'unit', acceptanceRefs: ['AC-01'], command: 'pnpm test -- list', status: 'blocked', exitCode: 0, summary: '测试环境不可用，当前无法执行。', evidencePath: 'runs/run-1/tests/TEST-LIST-01.json', evidenceSha256: 'a'.repeat(64) }],
    })).toThrow('阻塞或跳过的测试不得伪造退出码');
  });
});
