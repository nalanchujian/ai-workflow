import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { InstalledSkillSchema, type InstalledSkill } from '../domain/skill.js';
import { InstalledWorkflowProfileSchema, type InstalledWorkflowProfile } from '../domain/workflow-profile.js';

const RegistryV3Schema = z.object({
  schemaVersion: z.literal('aiw.skill-registry/v3'),
  skills: z.array(InstalledSkillSchema),
  profiles: z.array(InstalledWorkflowProfileSchema),
});

type Registry = z.infer<typeof RegistryV3Schema>;
type RegistryReplacement = Pick<Registry, 'skills' | 'profiles'>;
type RegistrySourceReplacement = RegistryReplacement & { sourceUrl: string };
type RegistryInstallSnapshot = Pick<Registry, 'skills'> & { recoveredInvalidRegistry: boolean };

class InvalidSkillRegistryError extends Error {
  constructor(cause: unknown) {
    super('技能注册表与当前 AIW 输出契约不兼容；请运行 aiw skills update --ref <团队版本> 重新安装团队技能包。', { cause });
    this.name = 'InvalidSkillRegistryError';
  }
}

export class SkillRegistry {
  constructor(private readonly path: string) {}

  async list(): Promise<InstalledSkill[]> {
    return (await this.read()).skills;
  }

  async listProfiles(): Promise<InstalledWorkflowProfile[]> {
    return (await this.read()).profiles;
  }

  /**
   * Installation is the one safe recovery path for a registry created by an
   * older CLI. It deliberately discards that unreadable registry only after
   * the incoming package has passed all parsing and contract checks.
   */
  async snapshotForInstall(): Promise<RegistryInstallSnapshot> {
    try {
      return { skills: (await this.read()).skills, recoveredInvalidRegistry: false };
    } catch (error) {
      if (error instanceof InvalidSkillRegistryError) {
        return { skills: [], recoveredInvalidRegistry: true };
      }
      throw error;
    }
  }

  async find(name: string, version?: string): Promise<InstalledSkill | undefined> {
    const matches = (await this.list()).filter((skill) => skill.name === name && (version === undefined || skill.version === version));
    return oneOrUndefined(matches, `技能引用不唯一：${name}${version === undefined ? '' : `@${version}`}`);
  }

  async findFromSource(
    name: string,
    version: string,
    source: { url: string; revision: string },
  ): Promise<InstalledSkill | undefined> {
    const matches = (await this.list()).filter((skill) => (
      skill.name === name
      && skill.version === version
      && skill.registrySource.url === source.url
      && skill.registrySource.revision === source.revision
    ));
    return oneOrUndefined(matches, `工作流模板中的技能引用不唯一：${name}@${version}`);
  }

  async findLocked(lock: Pick<InstalledSkill, 'name' | 'version' | 'registrySource' | 'sha256'>): Promise<InstalledSkill | undefined> {
    const matches = (await this.list()).filter((skill) => skill.name === lock.name
      && skill.version === lock.version
      && skill.registrySource.url === lock.registrySource.url
      && skill.registrySource.revision === lock.registrySource.revision
      && skill.sha256 === lock.sha256);
    return oneOrUndefined(matches, `已锁定技能引用不唯一：${lock.name}@${lock.version}`);
  }

  async findProfile(name: string): Promise<InstalledWorkflowProfile | undefined> {
    const matches = (await this.listProfiles()).filter((profile) => profile.name === name);
    return oneOrUndefined(matches, `工作流模板引用不唯一：${name}`);
  }

  async replace(input: RegistryReplacement): Promise<void> {
    const registry = RegistryV3Schema.parse({ schemaVersion: 'aiw.skill-registry/v3', ...input });
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, stringify(registry), 'utf8');
    await rename(temporaryPath, this.path);
  }

  async replaceSource(input: RegistrySourceReplacement, options: { recoverInvalidRegistry?: boolean } = {}): Promise<void> {
    let current: Registry;
    try {
      current = await this.read();
    } catch (error) {
      if (!options.recoverInvalidRegistry || !(error instanceof InvalidSkillRegistryError)) {
        throw error;
      }
      current = emptyRegistry();
    }
    const belongsToSource = (source: { url: string }): boolean => source.url === input.sourceUrl;
    await this.replace({
      skills: [...current.skills.filter((skill) => !belongsToSource(skill.registrySource)), ...input.skills],
      profiles: [...current.profiles.filter((profile) => !belongsToSource(profile.registrySource)), ...input.profiles],
    });
  }

  private async read(): Promise<Registry> {
    let content: string;
    try {
      content = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        return emptyRegistry();
      }
      throw error;
    }
    try {
      return RegistryV3Schema.parse(parse(content));
    } catch (error) {
      throw new InvalidSkillRegistryError(error);
    }
  }
}

function emptyRegistry(): Registry {
  return { schemaVersion: 'aiw.skill-registry/v3', skills: [], profiles: [] };
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
