import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { InstalledBundledMethodSchema, type InstalledBundledMethod } from '../domain/bundled-method-source.js';
import { InstalledSkillSchema, type InstalledSkill } from '../domain/skill.js';
import { InstalledWorkflowProfileSchema, type InstalledWorkflowProfile } from '../domain/workflow-profile.js';

const RegistryV2Schema = z.object({
  schemaVersion: z.literal('aiw.skill-registry/v2'),
  skills: z.array(InstalledSkillSchema),
  profiles: z.array(InstalledWorkflowProfileSchema),
  methods: z.array(InstalledBundledMethodSchema),
});

type Registry = z.infer<typeof RegistryV2Schema>;
type RegistryReplacement = Pick<Registry, 'skills' | 'profiles'> & { methods?: InstalledBundledMethod[] };
type RegistrySourceReplacement = RegistryReplacement & { sourceUrl: string };

export class SkillRegistry {
  constructor(private readonly path: string) {}

  async list(): Promise<InstalledSkill[]> {
    return (await this.read()).skills;
  }

  async listProfiles(): Promise<InstalledWorkflowProfile[]> {
    return (await this.read()).profiles;
  }

  async listMethods(): Promise<InstalledBundledMethod[]> {
    return (await this.read()).methods;
  }

  async find(name: string, version?: string): Promise<InstalledSkill | undefined> {
    const matches = (await this.list()).filter((skill) => skill.name === name && (version === undefined || skill.version === version));
    return oneOrUndefined(matches, `技能引用不唯一：${name}${version === undefined ? '' : `@${version}`}`);
  }

  async findLocked(lock: Pick<InstalledSkill, 'name' | 'version' | 'registrySource' | 'sha256'>): Promise<InstalledSkill | undefined> {
    const matches = (await this.list()).filter((skill) => skill.name === lock.name
      && skill.version === lock.version
      && skill.registrySource.url === lock.registrySource.url
      && skill.registrySource.revision === lock.registrySource.revision
      && skill.sha256 === lock.sha256);
    return oneOrUndefined(matches, `已锁定技能引用不唯一：${lock.name}@${lock.version}`);
  }

  async findProfile(name: string, version?: string): Promise<InstalledWorkflowProfile | undefined> {
    const matches = (await this.listProfiles()).filter((profile) => profile.name === name && (version === undefined || profile.version === version));
    return oneOrUndefined(matches, `工作流模板引用不唯一：${name}${version === undefined ? '' : `@${version}`}`);
  }

  async findMethod(source: InstalledBundledMethod['source']): Promise<InstalledBundledMethod | undefined> {
    const matches = (await this.listMethods()).filter((method) => (
      method.source.id === source.id
      && method.source.source === source.source
      && method.source.version === source.version
      && method.source.revision === source.revision
      && method.source.sha256 === source.sha256
    ));
    return oneOrUndefined(matches, `内置方法引用不唯一：${source.id}@${source.version}`);
  }

  async replace(input: RegistryReplacement): Promise<void> {
    const registry = RegistryV2Schema.parse({ schemaVersion: 'aiw.skill-registry/v2', ...input, methods: input.methods ?? [] });
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, stringify(registry), 'utf8');
    await rename(temporaryPath, this.path);
  }

  async replaceSource(input: RegistrySourceReplacement): Promise<void> {
    const current = await this.read();
    const incomingRevisions = new Set([
      ...input.skills.map((skill) => skill.registrySource.revision),
      ...input.profiles.map((profile) => profile.registrySource.revision),
      ...(input.methods ?? []).map((method) => method.registrySource.revision),
    ]);
    const replacesIncomingRevision = (source: { url: string; revision: string }): boolean => (
      source.url === input.sourceUrl && incomingRevisions.has(source.revision)
    );
    await this.replace({
      skills: [...current.skills.filter((skill) => !replacesIncomingRevision(skill.registrySource)), ...input.skills],
      profiles: [...current.profiles.filter((profile) => !replacesIncomingRevision(profile.registrySource)), ...input.profiles],
      methods: [...current.methods.filter((method) => !replacesIncomingRevision(method.registrySource)), ...(input.methods ?? [])],
    });
  }

  private async read(): Promise<Registry> {
    try {
      return RegistryV2Schema.parse(parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (isMissingFile(error)) {
        return { schemaVersion: 'aiw.skill-registry/v2', skills: [], profiles: [], methods: [] };
      }
      throw new Error('技能注册表无效', { cause: error });
    }
  }
}

function oneOrUndefined<T>(items: T[], errorMessage: string): T | undefined {
  if (items.length > 1) {
    throw new Error(errorMessage);
  }
  return items[0];
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
