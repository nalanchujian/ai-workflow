import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { DocumentUrlSchema } from '../domain/document-url.js';
import type { DesignImageInput } from '../domain/design.js';
import type { Task } from '../domain/task.js';
import { TaskSchema } from '../domain/task.js';
import { transitionNode } from './task-state-machine.js';
import type { TaskRunLock } from './task-run-lock.js';
import { TaskStore } from './task-store.js';

/** Persists information collected by each material-owning workflow node. */
export class TaskInputService {
  constructor(private readonly deps: { taskStore: TaskStore; taskLock?: TaskRunLock }) {}

  status(taskId: string): Promise<Task> { return this.deps.taskStore.load(taskId); }

  async saveRequirement(taskId: string, input: { url: string; section?: string }): Promise<Task> {
    const url = canonicalLarkUrl(input.url);
    const section = input.section?.trim();
    return this.locked(taskId, async () => {
      const task = await this.deps.taskStore.load(taskId);
      this.requireUnansweredReadyNode(task, 'requirement-analysis', 'requirement');
      const duplicates = (await this.deps.taskStore.list()).filter((candidate) => candidate.id !== task.id
        && candidate.status !== 'completed' && candidate.status !== 'cancelled'
        && candidate.inputs.requirement.status === 'provided' && candidate.inputs.requirement.url === url);
      if (duplicates.length > 0) throw new Error(`已存在相同需求的未完成任务：${duplicates.map((candidate) => candidate.id).join('、')}。请继续已有任务。`);
      task.inputs.requirement = { status: 'provided', url, ...(section === undefined || section.length === 0 ? {} : { section }) };
      return this.deps.taskStore.update(TaskSchema.parse(task));
    });
  }

  async saveApiDocuments(taskId: string, urls: string[]): Promise<{ task: Task; skipped: boolean }> {
    return this.locked(taskId, async () => {
      let task = await this.deps.taskStore.load(taskId);
      this.requireUnansweredReadyNode(task, 'api-analysis', 'apiDocuments');
      if (urls.length === 0) {
        task.inputs.apiDocuments = { status: 'absent' };
        task = skipNode(task, 'api-analysis', '未提供 YApi 接口文档，接口分析已跳过');
        return { task: await this.deps.taskStore.update(task), skipped: true };
      }
      task.inputs.apiDocuments = { status: 'provided', urls: canonicalYapiUrls(urls) };
      return { task: await this.deps.taskStore.update(TaskSchema.parse(task)), skipped: false };
    });
  }

  async saveDesignImage(taskId: string, imageFile: string | undefined): Promise<{ task: Task; skipped: boolean }> {
    return this.locked(taskId, async () => {
      let task = await this.deps.taskStore.load(taskId);
      this.requireUnansweredReadyNode(task, 'design-slicing', 'design');
      if (imageFile === undefined) {
        task.inputs.design = { status: 'absent' };
        task = skipNode(task, 'design-slicing', '未提供设计图，设计图切割已跳过');
        return { task: await this.deps.taskStore.update(task), skipped: true };
      }
      const image = await loadDesignImage(imageFile);
      await this.deps.taskStore.replaceBinaryFact(taskId, image.input.imagePath, image.content);
      task.inputs.design = { status: 'provided', image: image.input };
      return { task: await this.deps.taskStore.update(TaskSchema.parse(task)), skipped: false };
    });
  }

  private requireUnansweredReadyNode(task: Task, nodeId: 'requirement-analysis' | 'api-analysis' | 'design-slicing', input: 'requirement' | 'apiDocuments' | 'design'): void {
    if (task.nodes[nodeId]?.status !== 'ready') throw new Error(`当前不能为「${nodeId}」补充资料`);
    if (task.inputs[input].status !== 'not-asked') throw new Error(`「${nodeId}」的资料已记录，不能重复提交`);
  }

  private async locked<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    if (this.deps.taskLock === undefined) return action();
    const lease = await this.deps.taskLock.acquire({ taskId });
    if (lease === undefined) throw new Error('当前任务正在被其他命令修改，请稍后重试');
    try { return await action(); } finally { await lease.release(); }
  }
}

function canonicalLarkUrl(value: string): string {
  const url = new URL(DocumentUrlSchema.parse(value.trim()));
  if (url.protocol !== 'https:' || !(url.hostname.endsWith('.larksuite.com') || url.hostname.endsWith('.feishu.cn')) || !/^\/(docx|wiki)\/[A-Za-z0-9]+\/?$/.test(url.pathname)) throw new Error('需求文档只支持 Lark docx 或 wiki 地址');
  url.search = ''; url.hash = '';
  return url.href.replace(/\/$/, '');
}

function canonicalYapiUrls(urls: string[]): string[] {
  const values = urls.map((value) => value.trim()).filter(Boolean);
  const canonical = values.map((value) => {
    const url = new URL(DocumentUrlSchema.parse(value));
    if (url.protocol !== 'https:' || url.hostname !== 'yapi.hbdev.club' || !/^\/project\/149\/interface\/api\/[1-9]\d*\/?$/.test(url.pathname)) throw new Error('接口文档只支持当前 YApi 的文章地址');
    url.search = ''; url.hash = '';
    return url.href.replace(/\/$/, '');
  });
  if (canonical.length === 0) throw new Error('至少提供一个 YApi 接口文档地址');
  if (new Set(canonical).size !== canonical.length) throw new Error('接口文档 URL 不能重复');
  return canonical;
}

function skipNode(task: Task, nodeId: 'api-analysis' | 'design-slicing', note: string): Task {
  const runId = `input-skip-${Date.now()}`;
  const skipped = transitionNode(transitionNode(task, nodeId, { type: 'start', runId }), nodeId, { type: 'succeed', runId, outputs: [] });
  skipped.events[skipped.events.length - 1]!.note = note;
  return skipped;
}

async function loadDesignImage(file: string): Promise<{ input: DesignImageInput; content: Buffer }> {
  const content = await readFile(file).catch(() => { throw new Error('设计图文件不存在或无法读取'); });
  const mediaType = imageMediaType(content);
  if (mediaType === undefined) throw new Error('设计图只支持 PNG 或 JPEG 文件');
  const extension = mediaType === 'image/png' ? 'png' : 'jpg';
  const originalName = basename(file);
  const imageId = imageIdFor(originalName);
  return { content, input: { id: imageId, originalName, imagePath: `sources/design/${imageId}.${extension}`, mediaType } };
}

function imageMediaType(content: Buffer): 'image/png' | 'image/jpeg' | undefined {
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  return undefined;
}

function imageIdFor(fileName: string): string {
  const base = basename(fileName, extname(fileName)).toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-+|-+$/g, '');
  return /^[a-z]/.test(base) ? base : 'design-image';
}
