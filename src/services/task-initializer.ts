import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import type { SkillLock, SourceKind, Task, TaskNode } from '../domain/task.js';
import type { InstalledSkill } from '../domain/skill.js';
import { DesignInputSchema, type DesignImageInput } from '../domain/design.js';
import type { ProjectRepository } from '../ports/project-repository.js';
import { executableStages, requiredExecutableStages } from '../domain/workflow-profile.js';
import { SourceIntake, type SnapshotRecord } from './source-intake.js';
import { SkillRegistry } from './skill-registry.js';
import { TaskStore } from './task-store.js';
import { parseYapiDocumentIds, yapiInterfaceDocumentUrl } from './yapi-source-connector.js';

interface SourceIntakePort {
  classify?(value: string): SourceKind;
  snapshot(input: { sourceId: string; value: string; section?: string; revision?: number }): Promise<SnapshotRecord>;
  writeSnapshot(input: { snapshot: SnapshotRecord; taskDirectory: string }): ReturnType<SourceIntake['writeSnapshot']>;
}

export class TaskInitializer {
  constructor(private readonly deps: {
    registry: SkillRegistry;
    projectRepository: ProjectRepository;
    sourceIntakeFactory: (projectRoot: string) => SourceIntakePort;
    taskStoreFactory: (projectRoot: string) => TaskStore;
    now?: () => Date;
  }) {}

  async init(input: { projectRoot: string; source: string; section?: string; designImages?: string[]; apiDocumentIds?: string[]; skillProfile: string; forceNew?: boolean }): Promise<Task> {
    await this.deps.projectRepository.assertProjectReady(input.projectRoot);
    const taskStore = this.deps.taskStoreFactory(input.projectRoot);
    const sourceIntake = this.deps.sourceIntakeFactory(input.projectRoot);
    if (input.forceNew !== true) {
      await this.rejectDuplicateTask(taskStore, sourceIntake, input);
    }
    const id = taskIdAt(this.deps.now?.() ?? new Date());
    assertTaskId(id);
    const profile = await this.deps.registry.findProfile(input.skillProfile);
    if (profile === undefined) {
      throw new Error('工作流模板不存在');
    }

    const preparedDesign = await prepareDesignImages(input.projectRoot, input.designImages ?? []);
    const skills = await this.resolveSkills(profile.skills, profile.registrySource, preparedDesign.length > 0);
    const sourceId = 'requirements';
    const apiDocumentIds = parseYapiDocumentIds(input.apiDocumentIds ?? []);
    const source = await sourceIntake.snapshot({
      sourceId,
      value: input.source,
      ...(input.section === undefined ? {} : { section: input.section }),
      revision: 1,
    });
    const apiSources = await Promise.all(apiDocumentIds.map(async (apiDocumentId) => sourceIntake.snapshot({
      sourceId: apiSourceId(apiDocumentId),
      value: yapiInterfaceDocumentUrl(apiDocumentId),
      revision: 1,
    })));
    const projectConfig = await readProjectConfig(input.projectRoot);
    const taskDirectory = taskStore.taskDirectory(id);
    const stagingDirectory = join(dirname(taskDirectory), `.${id}.initializing-${randomUUID()}`);
    await mkdir(stagingDirectory, { recursive: true });
    try {
      const [writtenSource, ...writtenApiSources] = await Promise.all([
        sourceIntake.writeSnapshot({ snapshot: source, taskDirectory: stagingDirectory }),
        ...apiSources.map((apiSource) => sourceIntake.writeSnapshot({ snapshot: apiSource, taskDirectory: stagingDirectory })),
      ]);
      const designInput = preparedDesign.length === 0
        ? undefined
        : DesignInputSchema.parse({ provider: 'local-images', images: await writeDesignImages(stagingDirectory, preparedDesign) });
      const task: Task = {
        schemaVersion: 'aiw.task/v3',
        stateVersion: 0,
        id,
        title: `任务 ${id}`,
        repository: '.',
        status: 'active',
        skillProfile: {
          name: profile.name,
          registrySource: profile.registrySource,
          sha256: profile.sha256,
        },
        developmentSkill: lockSkill(skills.development),
        ...(designInput === undefined ? {} : { designInput }),
        sources: {
          [sourceId]: writtenSource,
          ...Object.fromEntries(writtenApiSources.map((apiSource, index) => [apiSourceId(apiDocumentIds[index]!), apiSource])),
        },
        nodes: createNodes(skills, designInput !== undefined, writtenApiSources),
        approvalRefs: [],
        events: [],
      };
      await taskStore.createFromStaging(task, stagingDirectory);
      if (projectConfig === undefined) {
        await writeProjectConfig(input.projectRoot);
      }
      return task;
    } catch (error) {
      await rm(stagingDirectory, { force: true, recursive: true });
      throw error;
    }
  }

  private async resolveSkills(
    references: Record<(typeof requiredExecutableStages)[number], string> & { design?: string },
    profileSource: { url: string; revision: string },
    includeDesign: boolean,
  ): Promise<ResolvedSkills> {
    const stages = includeDesign ? executableStages : requiredExecutableStages;
    const resolved = await Promise.all(stages.map(async (stage) => {
      const reference = references[stage];
      if (reference === undefined) throw new Error('当前工作流模板不支持设计图片处理，请先更新团队技能包');
      const [name, version] = parseReference(reference, `阶段 ${stage} 的技能`);
      const skill = await this.deps.registry.findFromSource(name, version, profileSource);
      if (skill === undefined || !skill.phases.includes(stage)) {
        throw new Error(`工作流模板引用了不兼容技能：${stage}`);
      }
      return [stage, skill] as const;
    }));
    return Object.fromEntries(resolved) as ResolvedSkills;
  }

  private async rejectDuplicateTask(taskStore: TaskStore, sourceIntake: SourceIntakePort, input: { projectRoot: string; source: string; section?: string }): Promise<void> {
    const sourceKind = sourceIntake.classify?.(input.source) ?? defaultSourceKind(input.source);
    const sourceOrigin = normalizeSourceOrigin(input.projectRoot, input.source, sourceKind);
    const sourceSection = normalizeSection(input.section);
    const duplicates = (await taskStore.list()).filter((task) => isUnfinished(task)
      && task.sources.requirements?.kind === sourceKind
      && normalizeSourceOrigin(input.projectRoot, task.sources.requirements.origin, sourceKind) === sourceOrigin
      && normalizeSection(task.sources.requirements.section) === sourceSection);
    if (duplicates.length === 0) {
      return;
    }
    const ids = duplicates.map((task) => task.id).join('、');
    throw new Error(`已存在相同需求的未完成任务：${ids}。请先执行 aiw task status <task-id> 查看并继续；确需重新创建时使用 --force-new。`);
  }
}

function taskIdAt(date: Date): string {
  const [day, clock] = date.toISOString().split('T');
  const [time, milliseconds] = clock.replace('Z', '').split('.');
  return `task-${day.replaceAll('-', '')}-${time.replaceAll(':', '')}-${milliseconds}`;
}

const ProjectConfigSchema = z.object({
  schemaVersion: z.literal('aiw.config/v1'),
  sourceSharing: z.object({
    default: z.literal('repository'),
    restricted: z.literal('require-redacted-snapshot'),
  }),
});

async function readProjectConfig(projectRoot: string): Promise<z.infer<typeof ProjectConfigSchema> | undefined> {
  const path = join(projectRoot, '.aiw', 'config.yaml');
  try {
    return ProjectConfigSchema.parse(parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw new Error('项目 AIW 配置无效', { cause: error });
  }
}

async function writeProjectConfig(projectRoot: string): Promise<void> {
  const path = join(projectRoot, '.aiw', 'config.yaml');
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, stringify({ schemaVersion: 'aiw.config/v1', sourceSharing: { default: 'repository', restricted: 'require-redacted-snapshot' } }), 'utf8');
  await rename(temporaryPath, path);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function assertTaskId(taskId: string): void {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(taskId)) {
    throw new Error('任务 ID 格式无效');
  }
}

function parseReference(reference: string, label: string): [string, string] {
  const match = /^([a-z][a-z0-9-]*)@(\d+\.\d+\.\d+)$/.exec(reference);
  if (match === null) {
    throw new Error(`${label}格式无效`);
  }
  return [match[1], match[2]];
}

function normalizeSourceOrigin(projectRoot: string, source: string, kind: SourceKind): string {
  if (kind === 'local-file') {
    return relative(resolve(projectRoot), resolve(projectRoot, source)).replaceAll('\\', '/');
  }
  const url = new URL(source);
  url.search = '';
  url.hash = '';
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

function defaultSourceKind(source: string): SourceKind {
  return /^https?:\/\//.test(source) ? 'public-url' : 'local-file';
}

function normalizeSection(section: string | undefined): string | undefined {
  return section?.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function isUnfinished(task: Task): boolean {
  return task.status !== 'completed'
    && task.status !== 'cancelled'
    && Object.values(task.nodes).some((node) => node.status !== 'completed' && node.status !== 'cancelled');
}

type ResolvedSkills = Record<(typeof requiredExecutableStages)[number], InstalledSkill> & { design?: InstalledSkill };

function createNodes(skills: ResolvedSkills, hasDesign: boolean, apiSources: Array<{ snapshotPath: string; metaPath: string }>): Record<string, TaskNode> {
  const stageDefinitions: Array<{ id: 'clarify' | 'solution' | 'plan'; title: string; outputs: string[]; requiresApproval: boolean }> = [
    { id: 'clarify', title: '澄清需求', outputs: ['artifacts/clarify/fact-register.yaml', 'artifacts/clarify/decision-register.yaml'], requiresApproval: true },
    { id: 'solution', title: '形成技术方案', outputs: ['artifacts/solution/solution.md'], requiresApproval: false },
    { id: 'plan', title: '制定开发计划', outputs: ['artifacts/plan/development-plan.yaml'], requiresApproval: true },
  ];
  const nodes: Record<string, TaskNode> = {
    intake: { title: '接入资料', phase: 'intake', dependsOn: [], requiresApproval: false, status: 'completed', hasResult: true, outputs: [] },
  };
  let dependency = 'intake';
  if (apiSources.length > 0) {
    nodes['api-document-recognition'] = {
      title: '识别 API 文档',
      phase: 'intake',
      dependsOn: ['intake'],
      requiresApproval: false,
      status: 'completed',
      hasResult: true,
      outputs: apiSources.flatMap((source) => [source.snapshotPath, source.metaPath]),
    };
    dependency = 'api-document-recognition';
  }
  for (const definition of stageDefinitions) {
    nodes[definition.id] = {
      title: definition.title,
      phase: definition.id,
      dependsOn: [dependency],
      skill: lockSkill(skills[definition.id]),
      requiresApproval: definition.requiresApproval,
      status: definition.id === 'clarify' ? 'ready' : 'pending',
      hasResult: false,
      outputs: definition.outputs,
    };
    dependency = definition.id;
  }
  if (hasDesign) {
    if (skills.design === undefined) throw new Error('当前工作流模板不支持设计图片处理，请先更新团队技能包');
    nodes['design-analysis'] = {
      title: '切割并绑定设计图片',
      phase: 'design',
      dependsOn: ['plan'],
      skill: lockSkill(skills.design),
      requiresApproval: false,
      status: 'pending',
      hasResult: false,
      outputs: ['artifacts/design/design-assets.yaml'],
    };
  }
  return nodes;
}

function apiSourceId(id: string): string {
  return `api-document-${id}`;
}

type PreparedDesignImage = { id: string; originalName: string; extension: '.png' | '.jpg'; mediaType: 'image/png' | 'image/jpeg'; content: Buffer };

async function prepareDesignImages(projectRoot: string, paths: string[]): Promise<PreparedDesignImage[]> {
  const used = new Set<string>();
  const prepared: PreparedDesignImage[] = [];
  for (const [index, inputPath] of paths.entries()) {
    const absolutePath = resolve(projectRoot, inputPath);
    let content: Buffer;
    try { content = await readFile(absolutePath); }
    catch { throw new Error(`无法读取设计图片：${inputPath}`); }
    const extension = normalizedImageExtension(inputPath, content);
    if (extension === undefined) throw new Error(`设计图片仅支持 PNG/JPEG：${inputPath}`);
    const base = slugifyDesignImage(basename(inputPath, extname(inputPath))) || `design-image-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    prepared.push({ id, originalName: basename(inputPath), extension, mediaType: extension === '.png' ? 'image/png' : 'image/jpeg', content });
  }
  return prepared;
}

async function writeDesignImages(taskDirectory: string, images: PreparedDesignImage[]): Promise<DesignImageInput[]> {
  return Promise.all(images.map(async (image) => {
    const imagePath = `sources/design/${image.id}${image.extension}`;
    await mkdir(dirname(join(taskDirectory, imagePath)), { recursive: true });
    await writeFile(join(taskDirectory, imagePath), image.content);
    return { id: image.id, originalName: image.originalName, imagePath, mediaType: image.mediaType };
  }));
}

function normalizedImageExtension(path: string, content: Buffer): '.png' | '.jpg' | undefined {
  if (content.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return '.jpg';
  return undefined;
}

function slugifyDesignImage(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function lockSkill(skill: InstalledSkill): SkillLock {
  return {
    name: skill.name,
    version: skill.version,
    registrySource: skill.registrySource,
    sha256: skill.sha256,
    methodSources: skill.methodSources,
  };
}
