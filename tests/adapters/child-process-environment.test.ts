import { describe, expect, it } from 'vitest';

import { minimalChildEnvironment } from '../../src/adapters/child-process-environment.js';

describe('minimalChildEnvironment', () => {
  it('does not pass arbitrary parent secrets but preserves explicit connector values', () => {
    const previous = process.env.AIW_TEST_SECRET;
    process.env.AIW_TEST_SECRET = 'should-not-leak';
    try {
      expect(minimalChildEnvironment({ LARK_APP_SECRET: 'explicit-secret' })).toMatchObject({ LARK_APP_SECRET: 'explicit-secret' });
      expect(minimalChildEnvironment()).not.toHaveProperty('AIW_TEST_SECRET');
    } finally {
      if (previous === undefined) delete process.env.AIW_TEST_SECRET;
      else process.env.AIW_TEST_SECRET = previous;
    }
  });
});
