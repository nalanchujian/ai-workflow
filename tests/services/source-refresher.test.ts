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

describe('SourceRefresher', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(removeTempDirectory));
  });

  it('creates a new revision and invalidates downstream nodes when Lark content changes', async () => {
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
    connector.content = '# Refund v2';
    const refresher = new SourceRefresher({ intake, taskStore: store });

    const result = await refresher.refresh({ sourceId: 'requirements', taskId: task.id });

    expect(result).toMatchObject({ changed: true, revision: 2 });
    expect(result.task.nodes.clarify.status).toBe('invalidated');
    await expect(readFile(join(store.taskDirectory(task.id), 'handoffs', 'intake', 'r2.yaml'), 'utf8')).resolves.toContain('revision: 2');
  });

  it('keeps the task unchanged when the refreshed content hash is unchanged', async () => {
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
