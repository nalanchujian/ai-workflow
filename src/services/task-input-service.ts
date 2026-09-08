import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { canonicalDocumentUrl, DocumentUrlSchema } from '../domain/document-url.js';
import type { DesignImageInput } from '../domain/design.js';
import type { InstalledSkill } from '../domain/skill.js';
import type { SkillLock, Task, TaskNode } from '../domain/task.js';
import type { InstalledWorkflowProfile } from '../domain/workflow-profile.js';
import { SkillRegistry } from './skill-registry.js';
import type { TaskRunLock } from './task-run-lock.js';
import { TaskStore } from './task-store.js';

/** Records optional materials and materializes only the matching workflow nodes. */
export class TaskInputService {
  constructor(private readonly deps: {
    taskStore: TaskStore;
    registry: SkillRegistry;
    taskLock?: TaskRunLock;
  }) {}

  status(taskId: string): Promise<Task> { return this.deps.taskStore.load(taskId); }

  async saveApiDocuments(taskId: string, urls: string[] | undefined): Promise<Task> {
    const selection = urls === undefined
      ? { status: 'absent' as const }
      : { status: 'provided' as const, urls: canonicalUrls(urls) };
    return this.locked(taskId, async () => {
      const task = await this.requireReadyForInputs(taskId);
      if (task.inputs.apiDocuments.status !== 'not-asked') throw new Error('接口文档已记录，不能重复提交');
      task.inputs.apiDocuments = selection;
      if (selection.status === 'provided') {
        task.nodes['api-analysis'] = createNode('api-analysis', await this.resolveSkills(task, 'api-analysis'), ['requirement-analysis'], 'ready');
      }
      refreshWorkflowDependencies(task);
      return this.deps.taskStore.update(task);
    });
  }

  async saveDesignImage(taskId: string, imageFile: string | undefined): Promise<Task> {
    return this.locked(taskId, async () => {
      const task = await this.requireReadyForInputs(taskId);
      if (task.inputs.design.status !== 'not-asked') throw new Error('设计图已记录，不能重复提交');
      if (imageFile === undefined) {
        task.inputs.design = { status: 'absent' };
      } else {
        const image = await loadDesignImage(imageFile);
        const skills = await this.resolveSkills(task, 'design-slicing');
        await this.deps.taskStore.replaceBinaryFact(taskId, image.input.imagePath, image.content);
        task.inputs.design = { status: 'provided', image: image.input };
        const dependency = task.nodes['api-analysis'] === undefined ? 'requirement-analysis' : 'api-analysis';
        task.nodes['design-slicing'] = createNode('design-slicing', skills, [dependency], dependency === 'requirement-analysis' ? 'ready' : 'pending');
      }
      refreshWorkflowDependencies(task);
      return this.deps.taskStore.update(task);
    });
  }

  private async requireReadyForInputs(taskId: string): Promise<Task> {
    const task = await this.deps.taskStore.load(taskId);
    if (task.nodes['requirement-analysis']?.status !== 'completed') {
      throw new Error('请先完成需求分析及待决策事项，再补充资料');
    }
    return task;
  }

  private async resolveSkills(task: Task, phase: 'api-analysis' | 'design-slicing'): Promise<SkillLock[]> {
    const profile = await this.deps.registry.findProfile(task.skillProfile.name);
    if (!isLockedProfile(profile, task)) throw new Error('当前工作流模板与任务锁定版本不一致，请恢复对应团队技能包后重试');
    const references = profile.skills[phase];
    const skills = await Promise.all(references.map(async (reference) => {
      const [name, version] = parseReference(reference);
      const skill = await this.deps.registry.findFromSource(name, version, task.skillProfile.registrySource);
      if (skill === undefined || !skill.phases.includes(phase)) throw new Error(`工作流模板引用了不兼容技能：${phase}`);
      return skill;
    }));
    return skills.map(lockSkill);
  }

  private async locked<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    if (this.deps.taskLock === undefined) return action();
    const lease = await this.deps.taskLock.acquire({ taskId });
    if (lease === undefined) throw new Error('当前任务正在被其他命令修改，请稍后重试');
    try { return await action(); } finally { await lease.release(); }
  }
}

function canonicalUrls(urls: string[]): string[] {
  if (urls.length === 0) throw new Error('至少提供一个接口文档 URL');
  const parsed = urls.map((url) => canonicalDocumentUrl(DocumentUrlSchema.parse(url.trim())));
  if (new Set(parsed).size !== parsed.length) throw new Error('接口文档 URL 不能重复');
  return parsed;
}

function createNode(phase: 'api-analysis' | 'design-slicing', skills: SkillLock[], dependsOn: string[], status: 'ready' | 'pending'): TaskNode {
  return phase === 'api-analysis'
    ? { title: '接口分析', phase, dependsOn, skills, requiresApproval: false, status, hasResult: false, outputs: ['artifacts/api-analysis/api-analysis.yaml'] }
    : { title: '设计图切割与绑定', phase, dependsOn, skills, requiresApproval: false, status, hasResult: false, outputs: ['artifacts/design/design-assets.yaml'] };
}

function refreshWorkflowDependencies(task: Task): void {
  const api = task.nodes['api-analysis'];
  const design = task.nodes['design-slicing'];
  if (api !== undefined && design !== undefined) {
    design.dependsOn = ['api-analysis'];
    if (api.status === 'completed' && design.status === 'pending') design.status = 'ready';
  }
  task.nodes.solution!.dependsOn = [design === undefined ? api === undefined ? 'requirement-analysis' : 'api-analysis' : 'design-slicing'];
}

function isLockedProfile(profile: InstalledWorkflowProfile | undefined, task: Task): profile is InstalledWorkflowProfile {
  return profile !== undefined
    && profile.sha256 === task.skillProfile.sha256
    && profile.registrySource.url === task.skillProfile.registrySource.url
    && profile.registrySource.revision === task.skillProfile.registrySource.revision;
}

function parseReference(reference: string): [string, string] {
  const match = /^([a-z][a-z0-9-]*)@(\d+\.\d+\.\d+)$/.exec(reference);
  if (match === null) throw new Error('工作流模板中的技能引用格式无效');
  return [match[1]!, match[2]!];
}

function lockSkill(skill: InstalledSkill): SkillLock {
  return { name: skill.name, version: skill.version, registrySource: skill.registrySource, sha256: skill.sha256 };
}

async function loadDesignImage(file: string): Promise<{ input: DesignImageInput; content: Buffer }> {
  const content = await readFile(file).catch(() => { throw new Error('设计图文件不存在或无法读取'); });
  const mediaType = imageMediaType(content);
  if (mediaType === undefined) throw new Error('设计图只支持 PNG 或 JPEG 文件');
  const extension = mediaType === 'image/png' ? 'png' : 'jpg';
  const originalName = basename(file);
  const imageId = imageIdFor(originalName);
  return {
    content,
    input: { id: imageId, originalName, imagePath: `sources/design/${imageId}.${extension}`, mediaType },
  };
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
