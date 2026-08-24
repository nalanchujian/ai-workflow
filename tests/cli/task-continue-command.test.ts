import { describe, expect, it } from 'vitest';

import { createTaskContinueCommand } from '../../src/cli/task-continue-command.js';

describe('task continue command', () => {
  it('stops before advancing when task facts still need to be committed', async () => {
    let ran = false;
    let output = '';
    const command = createTaskContinueCommand({
      runner: { async run() { ran = true; return { runId: 'run-1', status: 'succeeded' }; } } as never,
      taskState: state({
        task: activeTask({ solution: node('solution', 'ready') }),
        uncommitted: ['.aiw/tasks/refund-123/task.yaml'],
      }),
      stdout: stream((chunk) => { output += chunk; }),
    });

    await command.parseAsync(['node', 'continue', 'refund-123']);

    expect(ran).toBe(false);
    expect(output).toContain('继续任务前需要先提交任务记录');
    expect(output).toContain('git add .aiw && git commit -m "chore(aiw): record task facts"');
    expect(output).toContain('aiw task continue refund-123');
  });

  it('runs the next ready node without requiring the user to know its node id', async () => {
    let received: unknown;
    let output = '';
    const initial = activeTask({ solution: node('solution', 'ready') });
    const completed = { ...initial, status: 'completed', nodes: { solution: node('solution', 'completed') } };
    let statusCalls = 0;
    const command = createTaskContinueCommand({
      runner: {
        async run(input: unknown) {
          received = input;
          return { runId: 'run-1', status: 'succeeded' };
        },
      } as never,
      taskState: {
        ...state({ task: initial }),
        async status() { statusCalls += 1; return statusCalls === 1 ? initial : completed; },
      } as never,
      stdout: stream((chunk) => { output += chunk; }),
    });

    await command.parseAsync(['node', 'continue', 'refund-123']);

    expect(received).toEqual({ taskId: 'refund-123', nodeId: 'solution', dryRun: false, includes: [] });
    expect(output).toContain('「solution」节点已完成');
  });

  it('retries the failed node through the same continue command', async () => {
    let received: unknown;
    const initial = { ...activeTask({ solution: node('solution', 'failed') }), status: 'blocked' };
    const completed = { ...initial, status: 'completed', nodes: { solution: node('solution', 'completed') } };
    let statusCalls = 0;
    const command = createTaskContinueCommand({
      runner: {
        async run(input: unknown) { received = input; return { runId: 'run-2', status: 'succeeded' }; },
      } as never,
      taskState: {
        ...state({ task: initial as never }),
        async status() { statusCalls += 1; return (statusCalls === 1 ? initial : completed) as never; },
      },
      stdout: stream(() => undefined),
    });

    await command.parseAsync(['node', 'continue', 'refund-123']);

    expect(received).toEqual({ taskId: 'refund-123', nodeId: 'solution', dryRun: false, includes: [] });
  });

  it('keeps plan approval explicit instead of silently approving it', async () => {
    let ran = false;
    let output = '';
    const command = createTaskContinueCommand({
      runner: { async run() { ran = true; return { runId: 'run-1', status: 'succeeded' }; } } as never,
      taskState: state({ task: activeTask({ plan: node('plan', 'awaiting_approval') }) }),
      stdout: stream((chunk) => { output += chunk; }),
    });

    await command.parseAsync(['node', 'continue', 'refund-123']);

    expect(ran).toBe(false);
    expect(output).toContain('开发计划等待确认');
    expect(output).toContain('aiw task approve refund-123 plan --note "<审批说明>"');
  });

  it('opens the clarification review when the task is waiting for decisions', async () => {
    let output = '';
    let received: unknown;
    const initial = activeTask({ clarify: node('clarify', 'awaiting_approval') });
    const reviewed = activeTask({ clarify: node('clarify', 'completed'), solution: node('solution', 'ready') });
    const answers = ['1', '1'];
    const command = createTaskContinueCommand({
      runner: { async run() { throw new Error('should not run'); } } as never,
      taskState: {
        ...state({ task: initial }),
        async pendingDecisions() {
          return [{
            question: '采用哪个接口方案？', background: '当前有两个方案。', impact: '影响开发实现。',
            options: [{ title: '复用现有接口', tradeoffs: '改动较小。' }],
            recommendation: { option: 0, rationale: '优先复用。' },
          }];
        },
        async reviewClarify(_taskId: string, selections: unknown) { received = selections; return reviewed as never; },
      },
      reviewPrompter: { async ask() { return answers.shift() ?? ''; } },
      stdout: stream((chunk) => { output += chunk; }),
    });

    await command.parseAsync(['node', 'continue', 'refund-123']);

    expect(received).toEqual([{ index: 0, action: 'continue', option: 0, rationale: '优先复用。' }]);
    expect(output).toContain('采用哪个接口方案？');
    expect(output).toContain('需求澄清已确认');
  });
});

function state(input: { task: ReturnType<typeof activeTask>; uncommitted?: string[] }) {
  return {
    async status() { return input.task as never; },
    async uncommittedTaskPaths() { return input.uncommitted ?? []; },
    async runBusinessPaths() { return []; },
    async pendingDecisions() { return []; },
    async reviewClarify() { return input.task as never; },
  };
}

function activeTask(nodes: Record<string, ReturnType<typeof node>>) {
  return { id: 'refund-123', status: 'active', nodes } as const;
}

function node(phase: string, status: string) {
  return { title: phase, phase, status, dependsOn: [], outputs: [] };
}

function stream(write: (chunk: string) => void): NodeJS.WriteStream {
  return { write(chunk: string) { write(chunk); return true; } } as unknown as NodeJS.WriteStream;
}
