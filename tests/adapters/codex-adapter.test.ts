import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import type { RunRequest } from '../../src/domain/run.js';
import { outputContractFor } from '../../src/domain/output-contract.js';
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
    expect(context).toContain('可修改必要的业务代码和测试');
    expect(context).toContain('AIW 会记录全部 Git 变更作为运行证据');
    expect(context).toContain('所有 Markdown 产物必须以一级标题');
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
    expect(context).toContain('- .aiw/tasks/refund-123/runs/run-1/staging/artifacts/brief.md（发布后成为 artifacts/brief.md）');
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
    request.outputContract = outputContractFor(request.runId, request.artifacts);

    await adapter.run(request);

    const context = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(context).toContain('结构化交接包：.aiw/tasks/refund-123/runs/run-1/staging/handoffs/clarify/r3.yaml');
    expect(context).toContain('唯一**交接包先写入：.aiw/tasks/refund-123/runs/run-1/staging/handoffs/clarify/r3.yaml，经 AIW 校验后发布为 handoffs/clarify/r3.yaml（输出 revision：3）');
    expect(context).toContain('completed-revision="5" output-revision="3"');
    expect(context).toContain('phase: clarify');
    expect(context).toContain('revision: 3');
    expect(context).toContain('id: FACT-METRICS-01');
    expect(context).toContain('id: DEC-METRICS-01');
    expect(context).toContain('Handoff 中的事实只能复用正式事实登记已存在的 `FACT-*` ID');
    expect(context).toContain('Handoff 中的决策只能记录已由 AIW 确认的 `DEC-*`');
    expect(context).toContain('status: covered');
    expect(context).toContain('description: 未解决风险');
    expect(context).toContain('不得增加 schema 未定义字段');
  });

  it('requires a plan to declare machine-readable implementation units without path whitelists', async () => {
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
    request.artifacts = ['artifacts/implementation-plan.md', 'artifacts/work-breakdown.yaml'];
    request.outputContract = outputContractFor(request.runId, request.artifacts);

    await adapter.run(request);

    const context = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(context).toContain('不需要预先穷举可修改的文件路径');
    expect(context).toContain('「## 实施单元」');
    expect(context).toContain('每个 `units` 项只能使用');
    expect(context).toContain('acceptanceId: AC-01');
    expect(context).toContain('不得使用 `acceptanceRef`、`status`、`units`');
    expect(context).toContain('不得使用 `acceptanceIds`、`allowedPaths`');
  });

  it('requires clarify to turn unresolved facts into recommended decision options', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.aiw-runtime', 'run-decisions');
    const adapter = new CodexAdapter({
      processRunner: { async run() { return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; } },
    });
    const request = runRequest({ projectRoot, runDirectory });
    request.artifacts.push('artifacts/fact-register.yaml', 'artifacts/acceptance.yaml', 'artifacts/decision-register.yaml');
    request.outputContract = outputContractFor(request.runId, request.artifacts);

    await adapter.run(request);

    const context = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(context).toContain('artifacts/decision-register.yaml');
    expect(context).toContain('正式事实引用规则优先于上文示例');
    expect(context).toContain('验收项允许字段为 `id`、`title`、`description`、`factRefs`');
    expect(context).toContain('每个决策项只提供一至两个本期继续的 AI 方案');
    expect(context).toContain('一至两个本期继续的 AI 方案');
    expect(context).toContain('第一层自动记录为外部等待');
    expect(context).toContain('detail:');
    expect(context).toContain('一次人工选择只能解决一个独立业务结论');
    expect(context).toContain('aiw.decision-register/v1');
  });

  it('requires each delivery unit to emit machine-readable acceptance results', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.aiw-runtime', 'run-acceptance');
    const adapter = new CodexAdapter({
      processRunner: { async run() { return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; } },
    });
    const request = runRequest({ projectRoot, runDirectory });
    request.task = { ...request.task, nodeId: 'delivery-list', phase: 'implement', testPlan: [{ id: 'TEST-LIST-01', command: 'pnpm test -- list' }] };
    request.artifacts = ['artifacts/delivery.md', 'artifacts/test-results.yaml', 'artifacts/acceptance-results.yaml'];
    request.outputContract = outputContractFor(request.runId, request.artifacts);

    await adapter.run(request);

    const context = await readFile(join(runDirectory, 'context.md'), 'utf8');
    expect(context).toContain('artifacts/acceptance-results.yaml');
    expect(context).toContain('artifacts/test-results.yaml');
    expect(context).toContain('AIW 会在 Codex 结束后作为唯一执行者运行');
    expect(context).not.toContain('- .aiw/tasks/refund-123/artifacts/test-results.yaml');
    expect(context).toContain('不要**在交付报告、Handoff 或其他 Codex 产物中填写');
    expect(context).toContain('本次运行中完成代码实现、工程验证和验收测试');
  });

  it('places an exact output receipt after a stale skill instruction for a regenerated delivery node', async () => {
    const projectRoot = await temporaryDirectory();
    const runDirectory = join(projectRoot, '.aiw-runtime', 'run-regenerated-delivery');
    const adapter = new CodexAdapter({
      processRunner: { async run() { return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; } },
    });
    const request = runRequest({ projectRoot, runDirectory });
    request.task = {
      ...request.task,
      nodeId: 'delivery-list-custom-metrics-r2',
      phase: 'implement',
      testPlan: [{ id: 'TEST-LIST-01', command: 'node scripts/list.test.mjs' }],
    };
    request.artifacts = [
      'artifacts/delivery-list-custom-metrics-r2/r1/delivery.md',
      'artifacts/delivery-list-custom-metrics-r2/r1/test-results.yaml',
      'artifacts/delivery-list-custom-metrics-r2/r1/acceptance-results.yaml',
      'handoffs/delivery-list-custom-metrics-r2/r1.yaml',
    ];
    request.outputContract = outputContractFor(request.runId, request.artifacts);
    request.context.skill = {
      ...request.context.skill,
      content: '旧版技能错误地写着：生成 artifacts/delivery.md 和 artifacts/acceptance-results.yaml。',
    };

    await adapter.run(request);

    const context = await readFile(join(runDirectory, 'context.md'), 'utf8');
    const receipt = context.slice(context.lastIndexOf('<aiw-output-receipt>'));
    expect(receipt).toContain('.aiw/tasks/refund-123/runs/run-1/staging/artifacts/delivery-list-custom-metrics-r2/r1/delivery.md');
    expect(receipt).toContain('发布正式路径：.aiw/tasks/refund-123/artifacts/delivery-list-custom-metrics-r2/r1/delivery.md');
    expect(receipt).toContain('.aiw/tasks/refund-123/runs/run-1/staging/artifacts/delivery-list-custom-metrics-r2/r1/acceptance-results.yaml');
    expect(receipt).toContain('.aiw/tasks/refund-123/artifacts/delivery-list-custom-metrics-r2/r1/test-results.yaml（仅 AIW 写入）');
    expect(receipt).toContain('.aiw/tasks/refund-123/runs/run-1/staging/handoffs/delivery-list-custom-metrics-r2/r1.yaml');
    expect(receipt).toContain('忽略低优先级技能中的旧路径示例');
    expect(receipt).not.toContain('artifacts/delivery.md');
    expect(context).not.toContain('- .aiw/tasks/refund-123/artifacts/delivery-list-custom-metrics-r2/r1/test-results.yaml');
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
    schemaVersion: 'aiw.run/v2',
    runId: 'run-1',
    task: { id: 'refund-123', nodeId: 'clarify', phase: 'clarify', nodeRevision: 0, projectRoot: input.projectRoot, testPlan: [] },
    instruction: '澄清退款需求。',
    contextManifestPath: '.aiw/tasks/refund-123/runs/run-1/context-manifest.json',
    runDirectory: input.runDirectory,
    mode: 'execute',
    artifacts: ['artifacts/brief.md'],
    outputContract: outputContractFor('run-1', ['artifacts/brief.md']),
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
