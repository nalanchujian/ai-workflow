import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stringify } from 'yaml';

import { minimalChildEnvironment } from '../adapters/child-process-environment.js';
import { parseVerificationCommand } from '../domain/verification-command.js';
import { type TestResults, TestResultsSchema } from '../domain/test-results.js';
import type { Task, TaskNode } from '../domain/task.js';
import { nextArtifactPath } from '../domain/handoff.js';
import type { ProcessRunner } from '../ports/process-runner.js';
import { TaskStore } from './task-store.js';

const DEFAULT_TEST_TIMEOUT_MS = 10 * 60 * 1_000;

export type DeliveryTestPlanItem = { id: string; command: string };

/** Builds stable test IDs before Codex starts, so an AC can cite its real test. */
export function deliveryTestPlan(node: TaskNode): DeliveryTestPlanItem[] {
  const prefix = (node.workUnitId ?? 'delivery').toUpperCase();
  return node.verificationCommands.map((command, index) => ({
    id: `TEST-${prefix}-${String(index + 1).padStart(2, '0')}`,
    command,
  }));
}

/**
 * Runs the plan-approved commands outside Codex and makes their stdout/stderr
 * immutable task evidence. Codex may describe the result, but cannot author
 * this artifact.
 */
export class DeliveryTestExecutor {
  constructor(private readonly deps: { processRunner: ProcessRunner; timeoutMs?: number }) {}

  async execute(input: {
    task: Task;
    nodeId: string;
    node: TaskNode;
    runId: string;
    taskStore: TaskStore;
    projectRoot: string;
    signal?: AbortSignal;
  }): Promise<TestResults> {
    const plan = deliveryTestPlan(input.node);
    if (plan.length === 0) {
      throw new Error('交付单元未声明可由 AIW 执行的验证命令');
    }
    const items: TestResults['items'] = [];
    for (const item of plan) {
      if (input.signal?.aborted === true) break;
      const evidencePath = `runs/${input.runId}/tests/${item.id}.json`;
      let record: Record<string, unknown>;
      let status: TestResults['items'][number]['status'];
      let exitCode: number | null;
      try {
        const invocation = parseVerificationCommand(item.command);
        const result = await this.deps.processRunner.run({
          ...invocation,
          cwd: input.projectRoot,
          stdin: '',
          timeoutMs: this.deps.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
          env: minimalChildEnvironment(),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        exitCode = result.exitCode;
        status = result.exitCode === 0 && !result.timedOut && result.signal === null
          ? 'passed'
          : result.exitCode === null ? 'blocked' : 'failed';
        record = {
          schemaVersion: 'aiw.test-execution-evidence/v1',
          runId: input.runId,
          testId: item.id,
          command: item.command,
          status,
          exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      } catch (error) {
        status = 'blocked';
        exitCode = null;
        record = {
          schemaVersion: 'aiw.test-execution-evidence/v1',
          runId: input.runId,
          testId: item.id,
          command: item.command,
          status,
          exitCode,
          error: error instanceof Error ? error.message : 'AIW 无法启动测试命令',
        };
      }
      const evidenceContent = JSON.stringify(record, null, 2) + '\n';
      await writeTaskFile(input.taskStore, input.task.id, evidencePath, evidenceContent);
      items.push({
        id: item.id,
        command: item.command,
        status,
        exitCode,
        summary: testSummary(record),
        evidencePath,
        evidenceSha256: createHash('sha256').update(evidenceContent).digest('hex'),
      });
    }
    const results = TestResultsSchema.parse({ schemaVersion: 'aiw.test-results/v1', runId: input.runId, items });
    const outputPath = nextArtifactPath(input.nodeId, input.node, 'artifacts/test-results.yaml');
    await writeTaskFile(input.taskStore, input.task.id, outputPath, stringify(results));
    return results;
  }
}

async function writeTaskFile(taskStore: TaskStore, taskId: string, path: string, content: string): Promise<void> {
  const destination = join(taskStore.taskDirectory(taskId), path);
  await mkdir(join(destination, '..'), { recursive: true });
  await writeFile(destination, content, 'utf8');
}

function testSummary(record: Record<string, unknown>): string {
  if (record.status === 'passed') {
    return `AIW 已执行，退出码 0；stdout ${String(record.stdout ?? '').length} 字节。`;
  }
  if (record.status === 'failed') {
    return `AIW 已执行，退出码 ${String(record.exitCode)}；请查看运行证据。`;
  }
  return `AIW 未执行该命令：${String(record.error ?? '测试运行被阻塞。')}`;
}
