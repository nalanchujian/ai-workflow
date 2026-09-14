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
            nodes: { 'requirement-analysis': { status: 'awaiting_approval', phase: 'requirement-analysis' } },
            inputs: { requirement: { status: 'provided', url: 'https://acme.larksuite.com/docx/doccn123' }, apiDocuments: { status: 'not-asked' }, design: { status: 'not-asked' } },
          };
        },
        async uncommittedTaskPaths() { return ['.aiw/tasks/refund-123/task.yaml']; },
        async runBusinessPaths() { return []; },
      } as never,
      inputs: {} as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'run', 'refund-123', 'requirement-analysis', '--dry-run', '--include', 'src/refund.ts']);

    expect(received).toEqual({ taskId: 'refund-123', nodeId: 'requirement-analysis', dryRun: true, includes: ['src/refund.ts'] });
    expect(output).toContain('「requirement-analysis」节点已完成');
    expect(output).toContain('运行 ID：run-1');
    expect(output).toContain('下一步：');
    expect(output).toContain('aiw task review refund-123');
    expect(output).not.toContain('aiw task continue');
    expect(output).not.toContain('aiw task status refund-123');
    expect(output).not.toContain('"runId"');
  });

  it('stores a Lark requirement URL and optional section from command parameters', async () => {
    let saved: unknown;
    let received: unknown;
    const command = createTaskRunCommand({
      runner: { async run(input: unknown) { received = input; return { runId: 'run-2', status: 'succeeded', artifacts: [] }; } } as never,
      taskState: stateFor({ 'requirement-analysis': { status: 'ready', phase: 'requirement-analysis' } }, { requirement: { status: 'not-asked' }, apiDocuments: { status: 'not-asked' }, design: { status: 'not-asked' } }) as never,
      inputs: { async saveRequirement(_taskId: string, input: unknown) { saved = input; } } as never,
      stdout: writable(),
    });

    await command.parseAsync(['node', 'run', 'refund-123', 'requirement-analysis', '--requirement-url', 'https://acme.larksuite.com/docx/doccn123', '--section', '退款'], { from: 'node' });

    expect(saved).toEqual({ url: 'https://acme.larksuite.com/docx/doccn123', section: '退款' });
    expect(received).toMatchObject({ taskId: 'refund-123', nodeId: 'requirement-analysis', allowUncommittedInputs: true });
  });

  it('skips API analysis when --skip is supplied', async () => {
    let saved: unknown;
    let ran = false;
    const skippedTask = taskFor({
      'requirement-analysis': { status: 'completed', phase: 'requirement-analysis' },
      'api-analysis': { status: 'completed', phase: 'api-analysis' },
      'design-slicing': { status: 'ready', phase: 'design-slicing' },
    }, { requirement: { status: 'provided', url: 'https://acme.larksuite.com/docx/doccn123' }, apiDocuments: { status: 'absent' }, design: { status: 'not-asked' } });
    let output = '';
    const command = createTaskRunCommand({
      runner: { async run() { ran = true; throw new Error('not reached'); } } as never,
      taskState: {
        ...stateFor({
          'requirement-analysis': { status: 'completed', phase: 'requirement-analysis' },
          'api-analysis': { status: 'ready', phase: 'api-analysis' },
          'design-slicing': { status: 'pending', phase: 'design-slicing' },
        }, { requirement: { status: 'provided', url: 'https://acme.larksuite.com/docx/doccn123' }, apiDocuments: { status: 'not-asked' }, design: { status: 'not-asked' } }),
        async uncommittedTaskPaths() { return ['.aiw/tasks/refund-123/task.yaml']; },
      } as never,
      inputs: { async saveApiDocuments(_taskId: string, input: unknown) { saved = input; return { task: skippedTask, skipped: true }; } } as never,
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'run', 'refund-123', 'api-analysis', '--skip'], { from: 'node' });

    expect(saved).toEqual([]);
    expect(ran).toBe(false);
    expect(output).toContain('「api-analysis」节点已跳过');
    expect(output).toContain('aiw task run refund-123 design-slicing');
  });

  it('replaces API documents when a previous API analysis run failed', async () => {
    let saved: unknown;
    let received: unknown;
    const command = createTaskRunCommand({
      runner: { async run(input: unknown) { received = input; return { runId: 'retry-api-1', status: 'succeeded', artifacts: [] }; } } as never,
      taskState: stateFor({
        'requirement-analysis': { status: 'completed', phase: 'requirement-analysis' },
        'api-analysis': { status: 'failed', phase: 'api-analysis' },
      }, { requirement: { status: 'provided', url: 'https://acme.larksuite.com/docx/doccn123' }, apiDocuments: { status: 'provided', urls: ['https://yapi.hbdev.club/project/149/interface/api/1'] }, design: { status: 'not-asked' } }) as never,
      inputs: { async saveApiDocuments(_taskId: string, input: unknown) { saved = input; return { task: taskFor({}, {}), skipped: false }; } } as never,
      stdout: writable(),
    });

    await command.parseAsync(['node', 'run', 'refund-123', 'api-analysis', '--api-url', 'https://yapi.hbdev.club/project/149/interface/api/2'], { from: 'node' });

    expect(saved).toEqual(['https://yapi.hbdev.club/project/149/interface/api/2']);
    expect(received).toMatchObject({ taskId: 'refund-123', nodeId: 'api-analysis', allowUncommittedInputs: true });
  });
});

function stateFor(nodes: Record<string, { status: string; phase: string }>, inputs: unknown) {
  const task = taskFor(nodes, inputs);
  return {
    async status() { return task; },
    async uncommittedTaskPaths() { return []; },
    async runBusinessPaths() { return []; },
  };
}

function taskFor(nodes: Record<string, { status: string; phase: string }>, inputs: unknown) {
  return {
    id: 'refund-123', status: 'active', inputs,
    nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, { ...node, dependsOn: [] }])),
  };
}

function writable(): NodeJS.WriteStream { return { write() { return true; } } as unknown as NodeJS.WriteStream; }
