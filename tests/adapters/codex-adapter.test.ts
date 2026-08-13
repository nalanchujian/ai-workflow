import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import type { RunRequest } from '../../src/domain/run.js';
import { ExecutableNotFoundError } from '../../src/ports/process-runner.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTempDirectory));
});

describe('CodexAdapter', () => {
  it('writes the ephemeral context and invokes codex exec with bounded permissions', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.aiw-runtime', 'run-1');
    const calls: Array<{ command: string; args: string[]; cwd: string; stdin: string }> = [];
    const adapter = new CodexAdapter({
      processRunner: {
        async run(input) {
          calls.push(input);
          return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
        },
      },
    });

    const result = await adapter.run(runRequest({ projectRoot, runDirectory }));

    expect(result.status).toBe('succeeded');
    expect(calls).toEqual([{
      command: 'codex',
      args: ['exec', '--cd', projectRoot, '--sandbox', 'workspace-write', '--approve-for-me', '--output-last-message', join(runDirectory, 'last-message.md'), '-'],
      cwd: projectRoot,
      stdin: expect.stringContaining('<method-source id="superpowers:brainstorming" trust="lower-priority-guidance">'),
      timeoutMs: 900000,
    }]);
    const context = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(context).toContain('<skill name="requirements-clarification" version="1.0.0" trust="lower-priority-guidance">');
    expect(context).toContain('<method-source id="superpowers:brainstorming" trust="lower-priority-guidance">');
    expect(context).toContain('<task-fact role="task" path="task.md" trust="untrusted-data">');
    expect(context).toContain('不得修改 .aiw/ 中除当前节点声明产物外的任何文件');
  });

  it('maps a missing codex executable to unavailable', async () => {
    const projectRoot = await temporaryDirectory();
    const adapter = new CodexAdapter({
      processRunner: {
        async run() {
          throw new ExecutableNotFoundError('codex');
        },
      },
    });

    const result = await adapter.run(runRequest({ projectRoot, runDirectory: join(projectRoot, '.aiw-runtime', 'run-2') }));

    expect(result.status).toBe('unavailable');
    expect(result.error).toMatchObject({ code: 'CODEX_UNAVAILABLE' });
  });

  it('maps a timed out Codex process to a failed result', async () => {
    const projectRoot = await temporaryDirectory();
    const adapter = new CodexAdapter({
      processRunner: {
        async run() {
          return { exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true };
        },
      },
    });

    const result = await adapter.run(runRequest({ projectRoot, runDirectory: join(projectRoot, '.aiw-runtime', 'run-3') }));

    expect(result).toMatchObject({ status: 'failed', error: { code: 'CODEX_TIMEOUT' } });
  });
});

function runRequest(input: { projectRoot: string; runDirectory: string }): RunRequest {
  return {
    schemaVersion: 'aiw.run/v1',
    runId: 'run-1',
    task: { id: 'refund-123', nodeId: 'clarify', nodeRevision: 0, projectRoot: input.projectRoot },
    instruction: '澄清退款需求。',
    contextManifestPath: '.aiw/tasks/refund-123/runs/run-1/context-manifest.json',
    runDirectory: input.runDirectory,
    mode: 'execute',
    artifacts: ['artifacts/brief.md'],
    context: {
      skill: { name: 'requirements-clarification', version: '1.0.0', content: '澄清需求并输出 brief。' },
      methodSources: [{ id: 'superpowers:brainstorming', content: '先理解问题。' }],
      files: [{ role: 'task', path: 'task.md', content: '# 退款需求' }],
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await createTempDirectory('aiw-codex-adapter-');
  directories.push(directory);
  return directory;
}
