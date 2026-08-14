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
    const calls: Array<{ command: string; args: string[]; cwd: string; stdin: string; env?: NodeJS.ProcessEnv }> = [];
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
      args: ['exec', '--cd', projectRoot, '--approve-for-me', '--output-last-message', join(runDirectory, 'last-message.md'), '-'],
      cwd: projectRoot,
      stdin: expect.stringContaining('<method-source id="superpowers:brainstorming" trust="lower-priority-guidance">'),
      timeoutMs: 900000,
      env: expect.objectContaining({ PATH: expect.any(String) }),
    }]);
    const context = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(context).toContain('<skill name="requirements-clarification" version="1.0.0" trust="lower-priority-guidance">');
    expect(context).toContain('<method-source id="superpowers:brainstorming" trust="lower-priority-guidance">');
    expect(context).toContain('<task-fact role="task" path="task.md" trust="untrusted-data">');
    expect(context).toContain('不得修改 .aiw/ 中除当前节点声明产物外的任何文件');
    expect(context).toContain('允许修改的业务路径：src/refunds/**');
  });

  it('directs declared task artifacts to the task-specific directory', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.aiw-runtime', 'run-artifacts');
    const adapter = new CodexAdapter({
      processRunner: {
        async run() {
          return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
        },
      },
    });

    await adapter.run(runRequest({ projectRoot, runDirectory }));

    const context = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(context).toContain('- .aiw/tasks/refund-123/artifacts/brief.md');
  });

  it('requires the agent to generate a versioned structured handoff', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.aiw-runtime', 'run-handoff');
    const adapter = new CodexAdapter({
      processRunner: { async run() { return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; } },
    });
    const request = runRequest({ projectRoot, runDirectory });
    request.task.nodeRevision = 5;
    request.artifacts.push('handoffs/clarify/r3.yaml');

    await adapter.run(request);

    const context = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(context).toContain('结构化交接包：.aiw/tasks/refund-123/handoffs/clarify/r3.yaml');
    expect(context).toContain('phase: clarify');
    expect(context).toContain('revision: 3');
    expect(context).toContain('status: covered');
    expect(context).toContain('description: 未解决风险');
    expect(context).toContain('不得增加 schema 未定义字段');
  });

  it('requires a plan to declare machine-readable implementation paths', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.aiw-runtime', 'run-plan');
    const adapter = new CodexAdapter({
      processRunner: {
        async run() {
          return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
        },
      },
    });
    const request = runRequest({ projectRoot, runDirectory });
    request.task.nodeId = 'plan';
    request.artifacts = ['artifacts/implementation-plan.md'];

    await adapter.run(request);

    const context = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(context).toContain('实施计划产物必须包含以下 YAML 代码块');
    expect(context).toContain('allowedPaths:');
  });

  it('requires clarify to turn unresolved facts into recommended decision options', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.aiw-runtime', 'run-decisions');
    const adapter = new CodexAdapter({
      processRunner: { async run() { return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; } },
    });
    const request = runRequest({ projectRoot, runDirectory });
    request.artifacts.push('artifacts/decision-register.yaml');

    await adapter.run(request);

    const context = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(context).toContain('artifacts/decision-register.yaml');
    expect(context).toContain('选项、取舍和 AI 推荐');
    expect(context).toContain('aiw.decision-register/v1');
  });

  it('requires test to emit machine-readable acceptance results', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.aiw-runtime', 'run-acceptance');
    const adapter = new CodexAdapter({
      processRunner: { async run() { return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; } },
    });
    const request = runRequest({ projectRoot, runDirectory });
    request.task = { ...request.task, nodeId: 'test', phase: 'test' };
    request.artifacts = ['artifacts/test-report.md', 'artifacts/acceptance-results.yaml'];

    await adapter.run(request);

    const context = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(context).toContain('artifacts/acceptance-results.yaml');
    expect(context).toContain('没有真实测试证据不得写 `passed`');
  });

  it('requires task artifacts to use Simplified Chinese by default', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.aiw-runtime', 'run-language');
    const adapter = new CodexAdapter({
      processRunner: {
        async run() {
          return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
        },
      },
    });

    await adapter.run(runRequest({ projectRoot, runDirectory }));

    const context = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(context).toContain('所有任务产物必须使用简体中文撰写');
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
    task: { id: 'refund-123', nodeId: 'clarify', phase: 'clarify', nodeRevision: 0, projectRoot: input.projectRoot },
    instruction: '澄清退款需求。',
    contextManifestPath: '.aiw/tasks/refund-123/runs/run-1/context-manifest.json',
    runDirectory: input.runDirectory,
    mode: 'execute',
    artifacts: ['artifacts/brief.md'],
    allowedChangePaths: ['src/refunds/**'],
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
