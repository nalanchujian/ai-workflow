import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { InstalledSkillSchema, type InstalledSkill } from '../domain/skill.js';
import { InstalledWorkflowProfileSchema, type InstalledWorkflowProfile } from '../domain/workflow-profile.js';

const RegistrySchema = z.object({
  schemaVersion: z.literal('aiw.skill-registry/v1'),
  skills: z.array(InstalledSkillSchema),
  profiles: z.array(InstalledWorkflowProfileSchema),
});

type Registry = z.infer<typeof RegistrySchema>;

export class SkillRegistry {
  constructor(private readonly path: string) {}

  async list(): Promise<InstalledSkill[]> {
    return (await this.read()).skills;
  }

  async listProfiles(): Promise<InstalledWorkflowProfile[]> {
    return (await this.read()).profiles;
  }

  async find(name: string, version?: string): Promise<InstalledSkill | undefined> {
    const matches = (await this.list()).filter((skill) => skill.name === name && (version === undefined || skill.version === version));
    return oneOrUndefined(matches, `技能引用不唯一：${name}${version === undefined ? '' : `@${version}`}`);
  }

  async findProfile(name: string, version?: string): Promise<InstalledWorkflowProfile | undefined> {
    const matches = (await this.listProfiles()).filter((profile) => profile.name === name && (version === undefined || profile.version === version));
    return oneOrUndefined(matches, `工作流模板引用不唯一：${name}${version === undefined ? '' : `@${version}`}`);
  }

  async replace(input: { skills: InstalledSkill[]; profiles: InstalledWorkflowProfile[] }): Promise<void> {
    const registry = RegistrySchema.parse({ schemaVersion: 'aiw.skill-registry/v1', ...input });
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, stringify(registry), 'utf8');
    await rename(temporaryPath, this.path);
  }

  async replaceSource(input: { sourceUrl: string; skills: InstalledSkill[]; profiles: InstalledWorkflowProfile[] }): Promise<void> {
    const current = await this.read();
    await this.replace({
      skills: [...current.skills.filter((skill) => skill.registrySource.url !== input.sourceUrl), ...input.skills],
      profiles: [...current.profiles.filter((profile) => profile.registrySource.url !== input.sourceUrl), ...input.profiles],
    });
  }

  private async read(): Promise<Registry> {
    try {
      return RegistrySchema.parse(parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (isMissingFile(error)) {
        return { schemaVersion: 'aiw.skill-registry/v1', skills: [], profiles: [] };
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
