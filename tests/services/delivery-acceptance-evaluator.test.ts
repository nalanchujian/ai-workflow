import { describe, expect, it } from 'vitest';

import { evaluateDeliveryAcceptance } from '../../src/services/delivery-acceptance-evaluator.js';

describe('DeliveryAcceptanceEvaluator', () => {
  const intent = {
    schemaVersion: 'aiw.acceptance-intent/v1' as const,
    items: [{ id: 'AC-01', evidence: ['artifacts/delivery.md'], testPlanRefs: ['TEST-UNIT-01'] }],
  };

  it('makes a passing AC only when its platform test record passed with exit code 0', () => {
    const results = evaluateDeliveryAcceptance({
      intent,
      acceptanceRefs: ['AC-01'],
      tests: {
        schemaVersion: 'aiw.test-results/v1', runId: 'run-1', items: [{
          id: 'TEST-UNIT-01', command: 'pnpm exec vitest run unit.test.ts', status: 'passed', exitCode: 0,
          summary: 'AIW 已执行，退出码 0；stdout 9 字节。', evidencePath: 'runs/run-1/tests/TEST-UNIT-01.json', evidenceSha256: 'a'.repeat(64),
        }],
      },
    });

    expect(results.items).toEqual([expect.objectContaining({ id: 'AC-01', status: 'passed', testResultRefs: ['TEST-UNIT-01'] })]);
  });

  it('turns failed and unavailable tests into failed or blocked ACs instead of accepting an Agent claim', () => {
    const failed = evaluateDeliveryAcceptance({
      intent,
      acceptanceRefs: ['AC-01'],
      tests: {
        schemaVersion: 'aiw.test-results/v1', runId: 'run-1', items: [{
          id: 'TEST-UNIT-01', command: 'pnpm exec vitest run unit.test.ts', status: 'failed', exitCode: 1,
          summary: 'AIW 已执行，退出码 1；请查看运行证据。', evidencePath: 'runs/run-1/tests/TEST-UNIT-01.json', evidenceSha256: 'a'.repeat(64),
        }],
      },
    });
    const blocked = evaluateDeliveryAcceptance({
      intent,
      acceptanceRefs: ['AC-01'],
      tests: {
        schemaVersion: 'aiw.test-results/v1', runId: 'run-1', items: [{
          id: 'TEST-UNIT-01', command: 'pnpm exec vitest run unit.test.ts', status: 'blocked', exitCode: null,
          summary: 'AIW 未执行该命令：测试环境不可用。', evidencePath: 'runs/run-1/tests/TEST-UNIT-01.json', evidenceSha256: 'a'.repeat(64),
        }],
      },
    });

    expect(failed.items[0]?.status).toBe('failed');
    expect(blocked.items[0]?.status).toBe('blocked');
  });

  it('rejects an intent that claims an AC or test outside the approved unit plan', () => {
    expect(() => evaluateDeliveryAcceptance({
      intent: { ...intent, items: [{ ...intent.items[0]!, testPlanRefs: ['TEST-UNKNOWN-01'] }] },
      acceptanceRefs: ['AC-01'],
      tests: { schemaVersion: 'aiw.test-results/v1', runId: 'run-1', items: [{
        id: 'TEST-UNIT-01', command: 'pnpm exec vitest run unit.test.ts', status: 'passed', exitCode: 0,
        summary: 'AIW 已执行，退出码 0；stdout 9 字节。', evidencePath: 'runs/run-1/tests/TEST-UNIT-01.json', evidenceSha256: 'a'.repeat(64),
      }] },
    })).toThrow('本次计划外的测试');
  });
});
