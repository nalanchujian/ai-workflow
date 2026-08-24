import { describe, expect, it } from 'vitest';

import { createTaskRunCommand } from '../../src/cli/task-run-command.js';

describe('task run command', () => {
  it('forwards dry-run and include options to the task runner', async () => {
    let received: unknown;
    let output = '';
    const command = createTaskRunCommand({
      runner: {
        async run(input: { taskId: string; nodeId: string; dryRun: boolean; includes: string[] }) {
          received = input;
          return { runId: 'run-1', status: 'succeeded' };
        },
      } as never,
      taskState: {
        async status() {
          return {
            id: 'refund-123', status: 'active',
            nodes: { clarify: { status: 'awaiting_approval', phase: 'clarify' } },
          };
        },
        async uncommittedTaskPaths() { return ['.aiw/tasks/refund-123/task.yaml']; },
        async runBusinessPaths() { return []; },
      } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'run', 'refund-123', 'clarify', '--dry-run', '--include', 'src/refund.ts']);

    expect(received).toEqual({ taskId: 'refund-123', nodeId: 'clarify', dryRun: true, includes: ['src/refund.ts'] });
    expect(output).toContain('「clarify」节点已完成');
    expect(output).toContain('运行 ID：run-1');
    expect(output).toContain('下一步：');
    expect(output).toContain('aiw task continue refund-123');
    expect(output).not.toContain('aiw task status refund-123');
    expect(output).not.toContain('"runId"');
  });
});
