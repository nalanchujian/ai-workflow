import { describe, expect, it } from 'vitest';

import { AcceptanceResultsSchema, deliveryStatusFromAcceptanceResults } from '../../src/domain/acceptance-results.js';

describe('AcceptanceResultsSchema', () => {
  it('derives ready only when every acceptance item passed, deferred, or waived', () => {
    const results = AcceptanceResultsSchema.parse({
      schemaVersion: 'aiw.acceptance-results/v1',
      items: [
        { id: 'AC-01', status: 'passed', evidence: ['artifacts/test-report.md'] },
        { id: 'AC-02', status: 'deferred', evidence: ['decisions/DEC-API-01/r1.yaml'] },
      ],
    });

    expect(deliveryStatusFromAcceptanceResults(results)).toBe('ready');
  });

  it('derives not_ready when any acceptance item remains blocked or failed', () => {
    const results = AcceptanceResultsSchema.parse({
      schemaVersion: 'aiw.acceptance-results/v1',
      items: [
        { id: 'AC-01', status: 'passed', evidence: ['artifacts/test-report.md'] },
        { id: 'AC-02', status: 'blocked', evidence: ['artifacts/test-report.md'] },
      ],
    });

    expect(deliveryStatusFromAcceptanceResults(results)).toBe('not_ready');
  });
});
