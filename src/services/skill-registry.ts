import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { InstalledBundledMethodSchema, type InstalledBundledMethod } from '../domain/bundled-method-source.js';
import { InstalledSkillSchema, type InstalledSkill } from '../domain/skill.js';
import { InstalledWorkflowProfileSchema, type InstalledWorkflowProfile } from '../domain/workflow-profile.js';

const RegistryV1Schema = z.object({
  schemaVersion: z.literal('aiw.skill-registry/v1'),
  skills: z.array(InstalledSkillSchema),
  profiles: z.array(InstalledWorkflowProfileSchema),
});

const RegistryV2Schema = z.object({
  schemaVersion: z.literal('aiw.skill-registry/v2'),
  skills: z.array(InstalledSkillSchema),
  profiles: z.array(InstalledWorkflowProfileSchema),
  methods: z.array(InstalledBundledMethodSchema),
});

const RegistrySchema = z.union([RegistryV1Schema, RegistryV2Schema]).transform((registry) => ({
  schemaVersion: 'aiw.skill-registry/v2' as const,
  skills: registry.skills,
  profiles: registry.profiles,
  methods: registry.schemaVersion === 'aiw.skill-registry/v2' ? registry.methods : [],
}));

type Registry = z.infer<typeof RegistrySchema>;
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
    const registry = RegistrySchema.parse({ schemaVersion: 'aiw.skill-registry/v2', ...input, methods: input.methods ?? [] });
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, stringify(registry), 'utf8');
    await rename(temporaryPath, this.path);
  }

  async replaceSource(input: RegistrySourceReplacement): Promise<void> {
    const current = await this.read();
    await this.replace({
      skills: [...current.skills.filter((skill) => skill.registrySource.url !== input.sourceUrl), ...input.skills],
      profiles: [...current.profiles.filter((profile) => profile.registrySource.url !== input.sourceUrl), ...input.profiles],
      methods: [...current.methods.filter((method) => method.registrySource.url !== input.sourceUrl), ...(input.methods ?? [])],
    });
  }

  private async read(): Promise<Registry> {
    try {
      return RegistrySchema.parse(parse(await readFile(this.path, 'utf8')));
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
