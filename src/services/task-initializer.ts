import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import type { SkillLock, SourceKind, Task, TaskNode } from '../domain/task.js';
import { handoffPath, validateHandoff } from '../domain/handoff.js';
import type { InstalledSkill } from '../domain/skill.js';
import type { ProjectRepository } from '../ports/project-repository.js';
import { executableStages } from '../domain/workflow-profile.js';
import { SourceIntake, type SnapshotRecord } from './source-intake.js';
import { SkillRegistry } from './skill-registry.js';
import { TaskStore } from './task-store.js';

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

  async init(input: { projectRoot: string; source: string; section?: string; skillProfile: string; forceNew?: boolean }): Promise<Task> {
    await this.deps.projectRepository.assertProjectReady(input.projectRoot);
    const taskStore = this.deps.taskStoreFactory(input.projectRoot);
    const sourceIntake = this.deps.sourceIntakeFactory(input.projectRoot);
    if (input.forceNew !== true) {
      await this.rejectDuplicateTask(taskStore, sourceIntake, input);
    }
    const id = taskIdAt(this.deps.now?.() ?? new Date());
    assertTaskId(id);
    const [profileName, profileVersion] = parseReference(input.skillProfile, '工作流模板');
    const profile = await this.deps.registry.findProfile(profileName, profileVersion);
    if (profile === undefined) {
      throw new Error('工作流模板不存在');
    }

    const skills = await this.resolveSkills(profile.skills, profile.registrySource);
    const sourceId = 'requirements';
    const source = await sourceIntake.snapshot({
      sourceId,
      value: input.source,
      ...(input.section === undefined ? {} : { section: input.section }),
      revision: 1,
    });
    const projectConfig = await readProjectConfig(input.projectRoot);
    const taskDirectory = taskStore.taskDirectory(id);
    const stagingDirectory = join(dirname(taskDirectory), `.${id}.initializing-${randomUUID()}`);
    await mkdir(stagingDirectory, { recursive: true });
    try {
      const sourceReference = await sourceIntake.writeSnapshot({ snapshot: source, taskDirectory: stagingDirectory });
      await writeFile(join(stagingDirectory, 'task.md'), `# ${id}\n\n需求来源：${sourceReference.origin}\n`, 'utf8');
      const task: Task = {
        schemaVersion: 'aiw.task/v2',
        id,
        title: `任务 ${id}`,
        repository: '.',
        status: 'active',
        deliveryStatus: 'not_assessed',
        skillProfile: {
          name: profile.name,
          version: profile.version,
          registrySource: profile.registrySource,
          sha256: profile.sha256,
        },
        sources: { [sourceId]: sourceReference },
        nodes: createNodes(skills),
        approvalRefs: [],
        decisions: [],
        events: [],
      };
      const intakeHandoffPath = handoffPath('intake', task.nodes.intake.revision);
      const intakeHandoff = stringify({
        schemaVersion: 'aiw.handoff/v1',
        taskId: task.id,
        nodeId: 'intake',
        phase: 'intake',
        revision: task.nodes.intake.revision,
        summary: '已固化需求来源快照与提取边界。',
        facts: [{
          id: 'FACT-01',
          statement: `需求来源已固化：${sourceReference.origin}`,
          evidence: [{ path: sourceReference.snapshotPath }],
        }],
        decisions: [],
        acceptance: [],
        changes: [],
        verification: [],
        openRisks: [],
      });
      validateHandoff(intakeHandoff, {
        taskId: task.id,
        nodeId: 'intake',
        phase: 'intake',
        revision: task.nodes.intake.revision,
        evidencePaths: [sourceReference.snapshotPath, sourceReference.metaPath],
      });
      await mkdir(dirname(join(stagingDirectory, intakeHandoffPath)), { recursive: true });
      await writeFile(join(stagingDirectory, intakeHandoffPath), intakeHandoff, 'utf8');
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
    references: Record<(typeof executableStages)[number], string>,
    profileSource: { url: string; revision: string },
  ): Promise<Record<(typeof executableStages)[number], InstalledSkill>> {
    const resolved = await Promise.all(executableStages.map(async (stage) => {
      const [name, version] = parseReference(references[stage], `阶段 ${stage} 的技能`);
      const skill = await this.deps.registry.findFromSource(name, version, profileSource);
      if (skill === undefined || !skill.phases.includes(stage)) {
        throw new Error(`工作流模板引用了不兼容技能：${stage}`);
      }
      return [stage, skill] as const;
    }));
    return Object.fromEntries(resolved) as Record<(typeof executableStages)[number], InstalledSkill>;
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

function createNodes(skills: Record<(typeof executableStages)[number], InstalledSkill>): Record<string, TaskNode> {
  const stageDefinitions: Array<{ id: (typeof executableStages)[number]; title: string; outputs: string[]; requiresApproval: boolean }> = [
    { id: 'clarify', title: '澄清需求', outputs: ['artifacts/brief.md', 'artifacts/questions.md', 'artifacts/acceptance.md', 'artifacts/acceptance.yaml', 'artifacts/decision-register.yaml'], requiresApproval: true },
    { id: 'solution', title: '形成技术方案', outputs: ['artifacts/solution.md'], requiresApproval: false },
    { id: 'plan', title: '制定实施计划', outputs: ['artifacts/implementation-plan.md', 'artifacts/implementation-context.md', 'artifacts/work-breakdown.yaml'], requiresApproval: true },
    { id: 'implement', title: '完成实现', outputs: ['artifacts/implementation.md'], requiresApproval: false },
    { id: 'verify', title: '工程验证', outputs: ['artifacts/verification.md'], requiresApproval: false },
    { id: 'test', title: '测试验证', outputs: ['artifacts/test-report.md', 'artifacts/acceptance-results.yaml'], requiresApproval: true },
  ];
  const nodes: Record<string, TaskNode> = {
    intake: { title: '接入资料', phase: 'intake', dependsOn: [], requiresApproval: false, status: 'completed', revision: 1, outputs: ['sources/requirements/r1/snapshot.md', 'sources/requirements/r1/meta.json'] },
  };
  let dependency = 'intake';
  for (const definition of stageDefinitions) {
    nodes[definition.id] = {
      title: definition.title,
      phase: definition.id,
      dependsOn: [dependency],
      skill: lockSkill(skills[definition.id]),
      requiresApproval: definition.requiresApproval,
      status: definition.id === 'clarify' ? 'ready' : 'pending',
      revision: 0,
      outputs: definition.outputs,
      ...(definition.id === 'implement' ? { contextPath: 'artifacts/implementation-context.md', allowedPaths: [] } : {}),
    };
    dependency = definition.id;
  }
  return nodes;
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
