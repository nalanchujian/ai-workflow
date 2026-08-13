import { describe, expect, it } from 'vitest';

import { TaskFactGuard } from '../../src/services/task-fact-guard.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';

describe('TaskFactGuard', () => {
  it('rejects a downstream run when its required shared facts are not committed', async () => {
    const guard = new TaskFactGuard({
      repositoryStatus: { async uncommittedPaths() { return ['artifacts/implementation-plan.md']; } },
    });

    await expect(guard.assertCommitted({
      task: createSevenPhaseTask(),
      paths: ['task.yaml', 'artifacts/implementation-plan.md'],
    })).rejects.toMatchObject({ code: 'TASK_FACTS_UNCOMMITTED', paths: ['artifacts/implementation-plan.md'] });
  });
});
