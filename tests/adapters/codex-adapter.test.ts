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
    expect(prompt).toContain('development-unit-<英文 kebab-case 描述>');
    expect(prompt).toContain('dependencies 只引用同一计划中其他开发单元的 name');
    expect(prompt).toContain('codeScope');
    expect(prompt).not.toContain('acceptanceCoverage');
    expect(prompt).not.toContain('testPlan');
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

  it('tells a design-referenced development unit to use only its injected screenshots', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.runtime', 'run-development-design');
    const adapter = new CodexAdapter({ processRunner: { async run() { return ok(); } } });
    const request = runRequest({ projectRoot, runDirectory, phase: 'development', artifacts: ['artifacts/development/development-unit-page/result.md'] });
    request.context.files[0]!.content = 'designReferences:\n  - nodeId: 1:2\n    figmaUrl: https://www.figma.com/design/example/File?node-id=1-2\n    purpose: 页面布局';
    await adapter.run(request);

    const prompt = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(prompt).toContain('designReferences');
    expect(prompt).toContain('通过 --image 注入的关联截图');
    expect(prompt).toContain('不要重新打开 Figma');
    expect(prompt).not.toContain('Figma MCP');
  });

  it('requires design analysis to inspect the supplied Figma URL through Chrome', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.runtime', 'run-design-browser');
    const adapter = new CodexAdapter({ processRunner: { async run() { return ok(); } } });
    const request = runRequest({ projectRoot, runDirectory, phase: 'design', artifacts: ['artifacts/design/design-assets.yaml'] });
    request.instruction = '分析设计稿\nFigma 设计地址：https://www.figma.com/design/example/File?node-id=1-2';

    await adapter.run(request);

    const prompt = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(prompt).toContain('https://www.figma.com/design/example/File?node-id=1-2');
    expect(prompt).toContain('已登录的 Chrome');
    expect(prompt).toContain('Figma 原生');
    expect(prompt).toContain('claim URL 中 fileKey 与任务一致的已有 Figma 页签');
    expect(prompt).toContain('找不到时才新建临时页签');
    expect(prompt).toContain('只关闭本次新建的临时页签');
    expect(prompt).toContain('Actions → Copy as PNG');
    expect(prompt).toContain('image/png');
    expect(prompt).toContain('完整父节点 PNG');
    expect(prompt).toContain('绿色背景');
    expect(prompt).toContain('编号');
    expect(prompt).toContain('逻辑业务块');
    expect(prompt).toContain('本地裁切');
    expect(prompt).toContain('不得把直接子节点数量当作业务块数量');
    expect(prompt).toContain('不得修改 Figma 文件');
    expect(prompt).not.toContain('逐个检查属于该 Section 的 Thumbnail 条目');
    expect(prompt).not.toContain('tab.screenshot 返回的字节');
    expect(prompt).not.toContain('先保存完整浏览器截图');
    expect(prompt).not.toContain('screencapture -x');
    expect(prompt).not.toContain('osascript');
    expect(prompt).toContain('view_image');
    expect(prompt).toContain('file');
    expect(prompt).toContain('裁切图片数量必须等于逻辑业务块数量');
    expect(prompt).toContain('保留用户原有 Chrome 页签');
    expect(prompt).toContain('artifacts/design/assets/');
    expect(prompt).not.toContain('输出设计规则');
    expect(prompt).toContain('不得调用 Figma MCP');
  });

  it('always starts a fresh Codex session for design analysis retries', async () => {
    const projectRoot = await temporaryDirectory();
    const currentRun = join(projectRoot, '.runtime', 'task-1', 'current-run');
    const calls: Array<{ args: string[] }> = [];
    const adapter = new CodexAdapter({ processRunner: { async run(input) { calls.push(input); return ok(); } } });

    await adapter.run(runRequest({ projectRoot, runDirectory: currentRun, phase: 'design', artifacts: ['artifacts/design/design-assets.yaml'] }));

    expect(calls[0]!.args).toEqual([
      'exec', '--cd', projectRoot, '--approve-for-me', '--output-last-message', join(currentRun, 'last-message.md'), '-'
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
    schemaVersion: 'aiw.run/v3', runId: 'run-1',
    task: { id: 'task-1', nodeId: input.phase === 'development' ? 'development-unit-refund-entry' : input.phase, phase: input.phase, projectRoot: input.projectRoot },
    instruction: '完成当前节点。', contextManifestPath: '.aiw/tasks/task-1/runs/run-1/context-manifest.json', runDirectory: input.runDirectory,
    mode: 'execute', artifacts: input.artifacts, outputContract: outputContractFor('run-1', input.artifacts),
    context: {
      skill: { name: 'team-skill', version: '0.0.1', content: '按当前阶段完成工作。' },
      methodSources: [{ id: 'superpowers:brainstorming', content: '先理解问题。' }],
      files: [{ role: 'source', path: 'sources/requirements/snapshot.md', content: '# 需求' }],
      images: [],
    },
  };
}

function ok() { return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; }
async function temporaryDirectory(): Promise<string> { const directory = await createTempDirectory('aiw-codex-adapter-'); directories.push(directory); return directory; }
