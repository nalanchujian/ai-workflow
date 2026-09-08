import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import type { RunRequest } from '../../src/domain/run.js';
import { outputContractFor } from '../../src/domain/output-contract.js';
import { ExecutableNotFoundError } from '../../src/ports/process-runner.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';
import { developmentPlanYaml } from '../helpers/development-plan-yaml.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(removeTempDirectory)));

describe('CodexAdapter', () => {
  it('invokes an isolated Codex session with only the declared context and outputs', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.runtime', 'run-1');
    const calls: Array<{ command: string; args: string[]; stdin: string }> = [];
    const adapter = new CodexAdapter({ processRunner: { async run(input) { calls.push(input); return ok(); } } });

    const result = await adapter.run(runRequest({ projectRoot, runDirectory, phase: 'requirement-analysis', artifacts: ['artifacts/requirement-analysis/fact-register.yaml', 'artifacts/requirement-analysis/decision-register.yaml'] }));

    expect(result.status).toBe('succeeded');
    expect(calls[0]).toMatchObject({ command: 'codex', args: ['exec', '--cd', projectRoot, '--approve-for-me', '--output-last-message', join(runDirectory, 'last-message.md'), '-'] });
    const prompt = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(prompt).toContain('<artifact-protocol id="fact-register"');
    expect(prompt).toContain('<artifact-protocol id="decision-register"');
    expect(prompt).toContain('需求分析只读取本次需求文档快照');
    expect(prompt).toContain('不要生成验收标准、AC、跨文件 ID 或 Handoff');
    expect(prompt).toContain('runs/run-1/staging/artifacts/requirement-analysis/fact-register.yaml');
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
    expect(prompt).toContain('development-unit-<英文 kebab-case 描述>');
    expect(prompt).toContain('dependencies 只引用同一计划中其他开发单元的 name');
    expect(prompt).toContain('codeScope');
    expect(prompt).not.toContain('acceptanceCoverage');
    expect(prompt).not.toContain('testPlan');
  });

  it('injects every skill bound to the current phase in declaration order', async () => {
    const projectRoot = await temporaryDirectory();
    const request = runRequest({ projectRoot, runDirectory: join(projectRoot, '.runtime'), phase: 'solution', artifacts: ['artifacts/solution/solution.md'] });
    request.context.skills.push({ name: 'solution-review', version: '0.0.1', content: '复核技术方案。' });

    const prompt = new CodexAdapter({ processRunner: { async run() { return ok(); } } }).renderPrompt(request);

    expect(prompt.indexOf('name="team-skill"')).toBeLessThan(prompt.indexOf('name="solution-review"'));
    expect(prompt).toContain('复核技术方案。');
  });

  it('limits development to code and a development result', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.runtime', 'run-development');
    const adapter = new CodexAdapter({ processRunner: { async run() { return ok(); } } });
    await adapter.run(runRequest({ projectRoot, runDirectory, phase: 'development', artifacts: ['artifacts/development/development-unit-refund-entry/result.md'] }));

    const prompt = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(prompt).toContain('只完成当前业务单元的代码开发');
    expect(prompt).toContain('不要运行或宣称测试、验证、验收与生产交付');
    expect(prompt).toContain('「## 完成的代码修改」');
    expect(prompt).not.toContain('test-results.yaml');
  });

  it('provides an executable read-only plan validator that uses the real schema', async () => {
    const projectRoot = join(await temporaryDirectory(), "worktree with 'quote' and $value");
    const request = runRequest({ projectRoot, runDirectory: join(projectRoot, '.runtime'), phase: 'plan', artifacts: ['artifacts/plan/development-plan.yaml'] });
    const adapter = new CodexAdapter({ processRunner: { async run() { return ok(); } } });
    const prompt = adapter.renderPrompt(request);
    const command = /<aiw-plan-validation>[\s\S]*?```sh\n([^\n]+)\n```/.exec(prompt)?.[1];
    expect(command).toBeDefined();
    const stagedPath = join(projectRoot, '.aiw/tasks/task-1', request.outputContract.entries[0]!.stagingPath);
    await mkdir(dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, developmentPlanYaml());
    const run = () => promisify(execFile)('/bin/sh', ['-c', command!], { cwd: projectRoot });
    await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('开发单元第 5 项 · requirements 第 1 项') });
    expect(await readFile(stagedPath, 'utf8')).toBe(developmentPlanYaml());

    await writeFile(stagedPath, developmentPlanYaml(true));
    expect((await run()).stdout).toContain('开发计划结构校验通过');
    const invalidDependency = developmentPlanYaml(true).replace('dependencies: []', 'dependencies: [development-unit-missing]');
    await writeFile(stagedPath, invalidDependency);
    await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('未知开发单元') });
  });

  it('tells a design-referenced development unit to use only its injected screenshots', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.runtime', 'run-development-design');
    const adapter = new CodexAdapter({ processRunner: { async run() { return ok(); } } });
    const request = runRequest({ projectRoot, runDirectory, phase: 'development', artifacts: ['artifacts/development/development-unit-page/result.md'] });
    request.context.files[0]!.content = 'designReferences:\n  - assetId: main-page\n    imagePath: artifacts/design/assets/main-page.png\n    purpose: 页面布局';
    await adapter.run(request);

    const prompt = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(prompt).toContain('designReferences');
    expect(prompt).toContain('通过 --image 注入的关联截图');
    expect(prompt).toContain('不要访问设计网站');
    expect(prompt).not.toContain('外部设计地址');
  });

  it('uses only pre-exported local images during design segmentation', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.runtime', 'run-design-browser');
    const adapter = new CodexAdapter({ processRunner: { async run() { return ok(); } } });
    const request = runRequest({ projectRoot, runDirectory, phase: 'design-slicing', artifacts: ['artifacts/design/design-assets.yaml'] });
    request.instruction = '切割并绑定 2 张设计图片';

    await adapter.run(request);

    const prompt = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(prompt).toContain('输入图片已由用户提前导出');
    expect(prompt).toContain('不要访问设计网站');
    expect(prompt).not.toContain('外部设计地址');
  });

  it('starts a fresh Codex session and injects local images for design retries', async () => {
    const projectRoot = await temporaryDirectory();
    const currentRun = join(projectRoot, '.runtime', 'task-1', 'current-run');
    const calls: Array<{ args: string[] }> = [];
    const adapter = new CodexAdapter({ processRunner: { async run(input) { calls.push(input); return ok(); } } });

    const request = runRequest({ projectRoot, runDirectory: currentRun, phase: 'design-slicing', artifacts: ['artifacts/design/design-assets.yaml'] });
    request.context.images = [{ path: 'sources/design/main.png', absolutePath: join(projectRoot, 'sources/design/main.png') }];
    await adapter.run(request);

    expect(calls[0]!.args).toEqual([
      'exec', '--cd', projectRoot, '--approve-for-me', '--output-last-message', join(currentRun, 'last-message.md'), '--image', join(projectRoot, 'sources/design/main.png'), '-'
    ]);
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
    schemaVersion: 'aiw.run/v5', runId: 'run-1',
    task: { id: 'task-1', nodeId: input.phase === 'development' ? 'development-unit-refund-entry' : input.phase, phase: input.phase, projectRoot: input.projectRoot },
    instruction: '完成当前节点。', contextManifestPath: '.aiw/tasks/task-1/runs/run-1/context-manifest.json', runDirectory: input.runDirectory,
    mode: 'execute', artifacts: input.artifacts, outputContract: outputContractFor('run-1', input.artifacts),
    context: {
      skills: [{ name: 'team-skill', version: '0.0.1', content: '按当前阶段完成工作。' }],
      files: [{ role: 'source', path: 'sources/requirements/snapshot.md', content: '# 需求' }],
      images: [],
    },
  };
}

function ok() { return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; }
async function temporaryDirectory(): Promise<string> { const directory = await createTempDirectory('aiw-codex-adapter-'); directories.push(directory); return directory; }
