import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import type { SkillLock, Task, TaskNode } from '../domain/task.js';
import type { InstalledSkill } from '../domain/skill.js';
import { DocumentUrlSchema } from '../domain/document-url.js';
import type { ProjectRepository } from '../ports/project-repository.js';
import { requiredExecutableStages, type WorkflowProfile } from '../domain/workflow-profile.js';
import { SkillRegistry } from './skill-registry.js';
import { TaskStore } from './task-store.js';

export class TaskInitializer {
  constructor(private readonly deps: {
    registry: SkillRegistry;
    projectRepository: ProjectRepository;
    taskStoreFactory: (projectRoot: string) => TaskStore;
    now?: () => Date;
  }) {}

  async init(input: { projectRoot: string; source: string; skillProfile: string; forceNew?: boolean }): Promise<Task> {
    const requirementUrl = DocumentUrlSchema.parse(input.source);
    await this.deps.projectRepository.assertProjectReady(input.projectRoot);
    const taskStore = this.deps.taskStoreFactory(input.projectRoot);
    if (input.forceNew !== true) {
      await this.rejectDuplicateTask(taskStore, requirementUrl);
    }
    const id = taskIdAt(this.deps.now?.() ?? new Date());
    assertTaskId(id);
    const profile = await this.deps.registry.findProfile(input.skillProfile);
    if (profile === undefined) {
      throw new Error('工作流模板不存在');
    }

    const skills = await this.resolveSkills(profile.skills, profile.registrySource);
    const projectConfig = await readProjectConfig(input.projectRoot);
    const task: Task = {
        schemaVersion: 'aiw.task/v5',
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
        developmentSkills: lockSkills(skills.development),
        inputs: {
          requirementUrl,
          apiDocuments: { status: 'not-asked' },
          design: { status: 'not-asked' },
        },
        sources: {},
        nodes: createNodes(skills),
        approvalRefs: [],
        events: [],
      };
    await taskStore.create(task);
    if (projectConfig === undefined) {
      await writeProjectConfig(input.projectRoot);
    }
    return task;
  }

  private async resolveSkills(
    profileSkills: WorkflowProfile['skills'],
    profileSource: { url: string; revision: string },
  ): Promise<ResolvedSkills> {
    const stages = requiredExecutableStages;
    const resolved = await Promise.all(stages.map(async (stage) => {
      const references = referencesForStage(profileSkills[stage], stage);
      const skills = await Promise.all(references.map(async (reference) => {
        const [name, version] = parseReference(reference, `阶段 ${stage} 的技能`);
        const skill = await this.deps.registry.findFromSource(name, version, profileSource);
        if (skill === undefined || !skill.phases.includes(stage)) {
          throw new Error(`工作流模板引用了不兼容技能：${stage}`);
        }
        return skill;
      }));
      return [stage, skills] as const;
    }));
    return Object.fromEntries(resolved) as ResolvedSkills;
  }

  private async rejectDuplicateTask(taskStore: TaskStore, requirementUrl: string): Promise<void> {
    const duplicates = (await taskStore.list()).filter((task) => isUnfinished(task)
      && task.inputs.requirementUrl === requirementUrl);
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

function isUnfinished(task: Task): boolean {
  return task.status !== 'completed'
    && task.status !== 'cancelled'
    && Object.values(task.nodes).some((node) => node.status !== 'completed' && node.status !== 'cancelled');
}

type ResolvedSkills = Record<(typeof requiredExecutableStages)[number], InstalledSkill[]>;

function createNodes(skills: ResolvedSkills): Record<string, TaskNode> {
  const stageDefinitions: Array<{ id: 'requirement-analysis' | 'solution' | 'plan'; title: string; outputs: string[]; requiresApproval: boolean }> = [
    { id: 'requirement-analysis', title: '需求分析', outputs: ['artifacts/requirement-analysis/fact-register.yaml', 'artifacts/requirement-analysis/decision-register.yaml'], requiresApproval: false },
    { id: 'solution', title: '形成技术方案', outputs: ['artifacts/solution/solution.md'], requiresApproval: false },
    { id: 'plan', title: '制定开发计划', outputs: ['artifacts/plan/development-plan.yaml'], requiresApproval: false },
  ];
  const nodes: Record<string, TaskNode> = {};
  let dependency: string | undefined;
  for (const definition of stageDefinitions) {
    nodes[definition.id] = {
      title: definition.title,
      phase: definition.id,
      dependsOn: dependency === undefined ? [] : [dependency],
      skills: lockSkills(skills[definition.id]),
      requiresApproval: definition.requiresApproval,
      status: definition.id === 'requirement-analysis' ? 'ready' : 'pending',
      hasResult: false,
      outputs: definition.outputs,
    };
    dependency = definition.id;
  }
  return nodes;
}

function referencesForStage(references: string[] | undefined, stage: string): string[] {
  if (references === undefined || references.length === 0) throw new Error(`工作流模板缺少阶段技能：${stage}`);
  return references;
}

function lockSkill(skill: InstalledSkill): SkillLock {
  return {
    name: skill.name,
    version: skill.version,
    registrySource: skill.registrySource,
    sha256: skill.sha256,
  };
}

function lockSkills(skills: InstalledSkill[]): SkillLock[] {
  return skills.map(lockSkill);
}
