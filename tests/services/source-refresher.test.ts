import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NetworkClient } from '../../src/ports/network-client.js';
import type { SourceConnector } from '../../src/ports/source-connector.js';
import { SourceIntake } from '../../src/services/source-intake.js';
import { SourceRefresher } from '../../src/services/source-refresher.js';
import { TaskStore } from '../../src/services/task-store.js';
import { createSevenPhaseTask } from '../helpers/task-fixtures.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';
import { FileTaskRunLock } from '../../src/services/task-run-lock.js';

describe('SourceRefresher', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(removeTempDirectory));
  });

  it('refreshes the current source and restarts the downstream flow when Lark content changes', async () => {
    const projectRoot = await createTempDirectory('aiw-source-refresh-');
    directories.push(projectRoot);
    const connector = mutableLarkConnector('# Refund v1');
    const intake = new SourceIntake({ connectors: [connector], network: safeNetwork(), projectRoot });
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();
    const first = await intake.snapshot({ sourceId: 'requirements', value: 'https://example.larksuite.com/docx/doccn123' });
    const reference = await intake.writeSnapshot({ snapshot: first, taskDirectory: store.taskDirectory(task.id) });
    task.sources.requirements = reference;
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'completed';
    task.nodes.plan.status = 'completed';
    task.approvalRefs = ['approvals/clarify.yaml', 'approvals/plan.yaml'];
    await store.create(task);
    await store.createFact(task.id, 'approvals/clarify.yaml', '当前审批证据\n');
    connector.content = '# Refund v2';
    const refresher = new SourceRefresher({ intake, taskStore: store });

    const result = await refresher.refresh({ sourceId: 'requirements', taskId: task.id });

    expect(result).toMatchObject({ changed: true, revision: 2 });
    expect(result.task.nodes.clarify.status).toBe('ready');
    expect(result.task.nodes.solution.status).toBe('pending');
    expect(result.task.approvalRefs).toEqual([]);
    await expect(readFile(join(store.taskDirectory(task.id), 'approvals', 'clarify.yaml'), 'utf8')).resolves.toBe('当前审批证据\n');
  });

  it('keeps the task unchanged when the refreshed content is unchanged', async () => {
    const projectRoot = await createTempDirectory('aiw-source-refresh-');
    directories.push(projectRoot);
    const connector = mutableLarkConnector('# Refund v1');
    const intake = new SourceIntake({ connectors: [connector], network: safeNetwork(), projectRoot });
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();
    const first = await intake.snapshot({ sourceId: 'requirements', value: 'https://example.larksuite.com/docx/doccn123' });
    const reference = await intake.writeSnapshot({ snapshot: first, taskDirectory: store.taskDirectory(task.id) });
    task.sources.requirements = reference;
    await store.create(task);
    const refresher = new SourceRefresher({ intake, taskStore: store });

    const result = await refresher.refresh({ sourceId: 'requirements', taskId: task.id });

    expect(result).toMatchObject({ changed: false, revision: 1 });
    expect(result.task.nodes.clarify.status).toBe('ready');
  });

  it('refreshes the same selected Lark section instead of the complete document', async () => {
    const projectRoot = await createTempDirectory('aiw-source-refresh-');
    directories.push(projectRoot);
    const connector = mutableLarkConnector('## 订单退款流程\n退款规则\n## 其他需求\nv1');
    const intake = new SourceIntake({ connectors: [connector], network: safeNetwork(), projectRoot });
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();
    const first = await intake.snapshot({ sourceId: 'requirements', value: 'https://example.larksuite.com/docx/doccn123', section: '订单退款流程' });
    const reference = await intake.writeSnapshot({ snapshot: first, taskDirectory: store.taskDirectory(task.id) });
    task.sources.requirements = reference;
    await store.create(task);
    connector.content = '## 订单退款流程\n退款规则\n## 其他需求\nv2';

    const result = await new SourceRefresher({ intake, taskStore: store }).refresh({ sourceId: 'requirements', taskId: task.id });

    expect(result).toMatchObject({ changed: false, revision: 1 });
  });

  it('refreshes an API document from its recognition node without invalidating intake', async () => {
    const projectRoot = await createTempDirectory('aiw-source-refresh-');
    directories.push(projectRoot);
    const connector = mutableLarkConnector('# 接口 v1');
    const intake = new SourceIntake({ connectors: [connector], network: safeNetwork(), projectRoot });
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();
    const first = await intake.snapshot({ sourceId: 'api-document-17904', value: 'https://example.larksuite.com/docx/doccn17904' });
    task.sources['api-document-17904'] = await intake.writeSnapshot({ snapshot: first, taskDirectory: store.taskDirectory(task.id) });
    task.nodes['api-document-recognition'] = {
      title: '识别 API 文档', phase: 'intake', dependsOn: ['intake'], requiresApproval: false,
      status: 'completed', hasResult: true,
      outputs: [task.sources['api-document-17904']!.snapshotPath, task.sources['api-document-17904']!.metaPath],
    };
    task.nodes.clarify.dependsOn = ['api-document-recognition'];
    task.nodes.clarify.status = 'completed';
    task.nodes.solution.status = 'completed';
    await store.create(task);
    connector.content = '# 接口 v2';

    const result = await new SourceRefresher({ intake, taskStore: store }).refresh({ sourceId: 'api-document-17904', taskId: task.id });

    expect(result).toMatchObject({ changed: true, revision: 2 });
    expect(result.task.nodes.intake.status).toBe('completed');
    expect(result.task.nodes['api-document-recognition']).toMatchObject({ status: 'completed', outputs: ['sources/api-document-17904/r2/snapshot.md', 'sources/api-document-17904/r2/meta.json'] });
    expect(result.task.nodes.clarify.status).toBe('ready');
    expect(result.task.nodes.solution.status).toBe('pending');
  });

  it('does not read or replace a source while another command holds the task lock', async () => {
    const projectRoot = await createTempDirectory('aiw-source-refresh-');
    const runtimeRoot = await createTempDirectory('aiw-source-refresh-runtime-');
    directories.push(projectRoot, runtimeRoot);
    const connector = mutableLarkConnector('# Refund v1');
    const intake = new SourceIntake({ connectors: [connector], network: safeNetwork(), projectRoot });
    const store = new TaskStore(projectRoot);
    const task = createSevenPhaseTask();
    const first = await intake.snapshot({ sourceId: 'requirements', value: 'https://example.larksuite.com/docx/doccn123' });
    task.sources.requirements = await intake.writeSnapshot({ snapshot: first, taskDirectory: store.taskDirectory(task.id) });
    await store.create(task);
    const taskLock = new FileTaskRunLock(runtimeRoot);
    const lease = await taskLock.acquire({ taskId: task.id });
    connector.content = '# Refund v2';
    const refresher = new SourceRefresher({ intake, taskStore: store, taskLock });

    await expect(refresher.refresh({ sourceId: 'requirements', taskId: task.id }))
      .rejects.toThrow('当前任务正在被其他命令修改');
    await lease?.release();
    await expect(store.load(task.id)).resolves.toMatchObject({ stateVersion: 0, sources: { requirements: { revision: 1 } } });
  });
});

function mutableLarkConnector(content: string): SourceConnector & { content: string } {
  return {
    content,
    async fetch(input) {
      return {
        canonicalUrl: input,
        externalId: 'doccn123',
        extractor: 'lark-mcp/v1',
        fetchedAt: '2026-08-12T12:00:00.000Z',
        markdown: this.content,
      };
    },
    supports(input) {
      return input.includes('/docx/');
    },
  };
}

function safeNetwork(): NetworkClient {
  return {
    async fetch(input) {
      return { body: '', contentType: 'text/plain', url: input.url };
    },
    async resolve() {
      return ['8.8.8.8'];
    },
  };
}
