import { describe, expect, it } from 'vitest';

import { AcceptanceResultsSchema, deliveryStatusFromAcceptanceResults } from '../../src/domain/acceptance-results.js';

describe('AcceptanceResultsSchema', () => {
  it('derives ready only when every acceptance item passed', () => {
    const results = AcceptanceResultsSchema.parse({
      schemaVersion: 'aiw.acceptance-results/v1',
      items: [
        { id: 'AC-01', status: 'passed', evidence: ['artifacts/test-report.md'], testResultRefs: ['TEST-REFUND-01'] },
        { id: 'AC-02', status: 'passed', evidence: ['artifacts/test-report.md'], testResultRefs: ['TEST-REFUND-02'] },
      ],
    });

    expect(deliveryStatusFromAcceptanceResults(results)).toBe('ready');
  });

  it('derives not_ready when any acceptance item remains blocked or failed', () => {
    const results = AcceptanceResultsSchema.parse({
      schemaVersion: 'aiw.acceptance-results/v1',
      items: [
        { id: 'AC-01', status: 'passed', evidence: ['artifacts/test-report.md'], testResultRefs: ['TEST-REFUND-01'] },
        { id: 'AC-02', status: 'blocked', evidence: ['artifacts/test-report.md'], testResultRefs: [] },
      ],
    });

    expect(deliveryStatusFromAcceptanceResults(results)).toBe('not_ready');
  });

  it('rejects deferred or waived acceptance outcomes because scope and risk use separate facts', () => {
    expect(() => AcceptanceResultsSchema.parse({
      schemaVersion: 'aiw.acceptance-results/v1',
      items: [{ id: 'AC-01', status: 'waived', evidence: ['artifacts/delivery.md'], testResultRefs: [] }],
    })).toThrow();
  });

  it('rejects a passed acceptance item without a real test record reference', () => {
    expect(() => AcceptanceResultsSchema.parse({
      schemaVersion: 'aiw.acceptance-results/v1',
      items: [{ id: 'AC-01', status: 'passed', evidence: ['artifacts/delivery.md'], testResultRefs: [] }],
    })).toThrow('通过的验收项必须引用至少一条实际通过的测试记录');
  });
});
