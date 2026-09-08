import { describe, expect, it } from 'vitest';

import { createTaskInputCommand } from '../../src/cli/task-input-command.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';

describe('task inputs command', () => {
  it('collects multiple API URLs then one design image in order', async () => {
    const calls: Array<{ kind: string; value: string[] | string | undefined }> = [];
    const task = completedRequirementTask();
    let output = '';
    const command = createTaskInputCommand({
      inputs: {
        async status() { return task; },
        async saveApiDocuments(_taskId: string, urls: string[] | undefined) { calls.push({ kind: 'api', value: urls }); task.inputs.apiDocuments = urls === undefined ? { status: 'absent' } : { status: 'provided', urls }; return task; },
        async saveDesignImage(_taskId: string, image: string | undefined) { calls.push({ kind: 'design', value: image }); task.inputs.design = image === undefined ? { status: 'absent' } : { status: 'provided', image: { id: 'design', originalName: 'design.png', imagePath: 'sources/design/design.png', mediaType: 'image/png' } }; return task; },
      } as never,
      prompter: answers(['1', 'https://api.example.test/a', 'https://api.example.test/b', '', '1', '/tmp/design.png']),
      stdout: writable((value) => { output += value; }),
    });

    await command.parseAsync(['node', 'inputs', 'refund-123']);

    expect(calls).toEqual([{ kind: 'api', value: ['https://api.example.test/a', 'https://api.example.test/b'] }, { kind: 'design', value: '/tmp/design.png' }]);
    expect(output).toContain('补充资料已保存');
  });

  it('resumes with the unanswered design question after API selection was saved', async () => {
    const calls: Array<{ kind: string; value: string[] | string | undefined }> = [];
    const task = completedRequirementTask();
    task.inputs.apiDocuments = { status: 'absent' };
    const command = createTaskInputCommand({
      inputs: {
        async status() { return task; },
        async saveApiDocuments() { throw new Error('must not ask again'); },
        async saveDesignImage(_taskId: string, image: string | undefined) { calls.push({ kind: 'design', value: image }); task.inputs.design = { status: 'absent' }; return task; },
      } as never,
      prompter: answers(['2']), stdout: writable(() => undefined),
    });

    await command.parseAsync(['node', 'inputs', 'refund-123']);

    expect(calls).toEqual([{ kind: 'design', value: undefined }]);
  });
});

function completedRequirementTask() {
  const task = createSevenPhaseTask();
  task.nodes['requirement-analysis']!.status = 'completed';
  return task;
}

function answers(values: string[]) { return { async ask() { const next = values.shift(); if (next === undefined) throw new Error('缺少测试输入'); return next; } }; }
function writable(write: (value: string) => void): NodeJS.WriteStream { return { write(value: string) { write(value); return true; } } as unknown as NodeJS.WriteStream; }
