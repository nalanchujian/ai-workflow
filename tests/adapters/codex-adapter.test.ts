import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import type { RunRequest } from '../../src/domain/run.js';
import { outputContractFor } from '../../src/domain/output-contract.js';
import { ExecutableNotFoundError } from '../../src/ports/process-runner.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

describe('CodexAdapter', () => {
  it('invokes an isolated Codex session with only the declared context and outputs', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.runtime', 'run-1');
    const calls: Array<{ command: string; args: string[]; stdin: string }> = [];
    const adapter = new CodexAdapter({ processRunner: { async run(input) { calls.push(input); return ok(); } } });

    const result = await adapter.run(runRequest({ projectRoot, runDirectory, phase: 'clarify', artifacts: ['artifacts/clarify/fact-register.yaml', 'artifacts/clarify/decision-register.yaml'] }));

    expect(result.status).toBe('succeeded');
    expect(calls[0]).toMatchObject({ command: 'codex', args: ['exec', '--cd', projectRoot, '--approve-for-me', '--output-last-message', join(runDirectory, 'last-message.md'), '-'] });
    const prompt = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(prompt).toContain('<artifact-protocol id="fact-register"');
    expect(prompt).toContain('<artifact-protocol id="decision-register"');
    expect(prompt).toContain('只生成事实登记和决策登记');
    expect(prompt).toContain('不要生成验收标准、AC、跨文件 ID 或 Handoff');
    expect(prompt).toContain('runs/run-1/staging/artifacts/clarify/fact-register.yaml');
    expect(prompt).not.toContain('acceptance-catalog');
  });

  it('tells plan to create development units without test or acceptance contracts', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.runtime', 'run-plan');
    const adapter = new CodexAdapter({ processRunner: { async run() { return ok(); } } });
    await adapter.run(runRequest({ projectRoot, runDirectory, phase: 'plan', artifacts: ['artifacts/plan/development-plan.yaml'] }));

    const prompt = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(prompt).toContain('<artifact-protocol id="development-plan"');
    expect(prompt).toContain('不规划测试、验证或验收');
    expect(prompt).toContain('codeScope');
    expect(prompt).not.toContain('acceptanceCoverage');
    expect(prompt).not.toContain('testPlan');
  });

  it('limits development to code and a development result', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.runtime', 'run-development');
    const adapter = new CodexAdapter({ processRunner: { async run() { return ok(); } } });
    await adapter.run(runRequest({ projectRoot, runDirectory, phase: 'development', artifacts: ['artifacts/development/development-unit-1/result.md'] }));

    const prompt = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(prompt).toContain('只完成当前业务单元的代码开发');
    expect(prompt).toContain('不要运行或宣称测试、验证、验收与生产交付');
    expect(prompt).toContain('「## 完成的代码修改」');
    expect(prompt).not.toContain('test-results.yaml');
  });

  it('maps missing Codex and timeouts to stable failures', async () => {
    const projectRoot = await temporaryDirectory();
    const missing = new CodexAdapter({ processRunner: { async run() { throw new ExecutableNotFoundError('codex'); } } });
    expect((await missing.run(runRequest({ projectRoot, runDirectory: join(projectRoot, 'missing'), phase: 'solution', artifacts: ['artifacts/solution/solution.md'] }))).status).toBe('unavailable');

    const timeout = new CodexAdapter({ processRunner: { async run() { return { exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true }; } } });
    expect(await timeout.run(runRequest({ projectRoot, runDirectory: join(projectRoot, 'timeout'), phase: 'solution', artifacts: ['artifacts/solution/solution.md'] }))).toMatchObject({ status: 'failed', error: { code: 'CODEX_TIMEOUT' } });
  });
});

function runRequest(input: { projectRoot: string; runDirectory: string; phase: RunRequest['task']['phase']; artifacts: string[] }): RunRequest {
  return {
    schemaVersion: 'aiw.run/v3', runId: 'run-1',
    task: { id: 'task-1', nodeId: input.phase === 'development' ? 'development-unit-1' : input.phase, phase: input.phase, projectRoot: input.projectRoot },
    instruction: '完成当前节点。', contextManifestPath: '.aiw/tasks/task-1/runs/run-1/context-manifest.json', runDirectory: input.runDirectory,
    mode: 'execute', artifacts: input.artifacts, outputContract: outputContractFor('run-1', input.artifacts),
    context: {
      skill: { name: 'team-skill', version: '0.0.1', content: '按当前阶段完成工作。' },
      methodSources: [{ id: 'superpowers:brainstorming', content: '先理解问题。' }],
      files: [{ role: 'source', path: 'sources/requirements/snapshot.md', content: '# 需求' }],
    },
  };
}

function ok() { return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; }
async function temporaryDirectory(): Promise<string> { const directory = await createTempDirectory('aiw-codex-adapter-'); directories.push(directory); return directory; }
