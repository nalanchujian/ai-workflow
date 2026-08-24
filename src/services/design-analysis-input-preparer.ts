import type { Task } from '../domain/task.js';
import type { DesignConnector } from '../ports/design-connector.js';
import { TaskStore } from './task-store.js';

export class DesignAnalysisInputPreparer {
  constructor(private readonly deps: { taskStore: TaskStore; connector: DesignConnector }) {}

  async prepare(task: Task): Promise<void> {
    const input = task.designInput;
    if (input === undefined) throw new Error('任务没有登记 Figma 设计稿');
    if (!this.deps.connector.supports(input.url)) throw new Error('当前设计连接器不支持该 Figma 地址');
    const capture = await this.deps.connector.captureRoot({ url: input.url });
    await this.deps.taskStore.replaceFact(task.id, 'sources/design/current/metadata.txt', capture.metadata.trim() + '\n');
    await this.deps.taskStore.replaceBinaryFact(task.id, 'sources/design/current/overview.png', capture.screenshot);
    await this.deps.taskStore.replaceFact(task.id, 'sources/design/current/meta.json', JSON.stringify({
      schemaVersion: 'aiw.design-source/v1',
      provider: 'figma',
      url: input.url,
      fileKey: capture.fileKey,
      nodeId: capture.nodeId,
      capturedAt: capture.capturedAt,
    }, null, 2) + '\n');
  }
}
