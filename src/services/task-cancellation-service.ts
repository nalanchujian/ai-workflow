import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TaskStore } from './task-store.js';

export class TaskCancellationService {
  constructor(private readonly deps: { taskStore: TaskStore; runtimeRoot: string; terminate?: (processId: number) => void }) {}

  async request(input: { taskId: string; nodeId: string; note: string }): Promise<{ taskId: string; nodeId: string; runId: string; status: 'requested' | 'signalled' }> {
    const task = await this.deps.taskStore.load(input.taskId);
    const node = task.nodes[input.nodeId];
    if (node?.status !== 'running') throw new Error('只能取消运行中的节点');
    const runId = [...task.events].reverse().find((event) => event.type === 'start' && event.nodeId === input.nodeId)?.runId;
    if (runId === undefined) throw new Error('未找到当前节点的运行记录');
    const runDirectory = join(this.deps.runtimeRoot, input.taskId, runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, 'cancel-request.json'), JSON.stringify({ taskId: input.taskId, nodeId: input.nodeId, requestedAt: new Date().toISOString(), note: input.note }) + '\n', 'utf8');
    const processId = await activeProcessId(runDirectory);
    if (processId === undefined) return { taskId: input.taskId, nodeId: input.nodeId, runId, status: 'requested' };
    (this.deps.terminate ?? ((pid) => process.kill(pid, 'SIGTERM')))(processId);
    return { taskId: input.taskId, nodeId: input.nodeId, runId, status: 'signalled' };
  }
}

async function activeProcessId(runDirectory: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(join(runDirectory, 'process.json'), 'utf8')) as { processId?: unknown; pid?: unknown };
    const candidate = value.processId ?? value.pid;
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : undefined;
  } catch {
    return undefined;
  }
}
