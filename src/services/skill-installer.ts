import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

import { SkillSchema, type InstalledSkill } from '../domain/skill.js';
import { WorkflowProfileSchema, type InstalledWorkflowProfile } from '../domain/workflow-profile.js';
import type { GitClient } from '../ports/git-client.js';
import { MethodSourceResolver } from './method-source-resolver.js';
import { SkillRegistry } from './skill-registry.js';

export interface InstallResult {
  skills: InstalledSkill[];
  profiles: InstalledWorkflowProfile[];
}

export class SkillInstaller {
  constructor(private readonly deps: { git: GitClient; methodSources: MethodSourceResolver; registry: SkillRegistry }) {}

  async install(input: { url: string; ref?: string }): Promise<InstallResult> {
    const cloned = await this.deps.git.clone(input);
    const registrySource = { url: input.url, revision: cloned.revision };
    const skills = await this.readSkills(cloned.directory, registrySource);
    const installedSkills = await this.deps.registry.list();
    const profiles = await this.readProfiles(
      cloned.directory,
      registrySource,
      [...installedSkills.filter((skill) => skill.registrySource.url !== input.url), ...skills],
    );
    if (skills.length === 0 && profiles.length === 0) {
      throw new Error('技能包未包含有效技能或工作流模板');
    }
    await this.deps.registry.replaceSource({ sourceUrl: input.url, skills, profiles });
    return { skills, profiles };
  }

  private async readSkills(directory: string, registrySource: { url: string; revision: string }): Promise<InstalledSkill[]> {
    const skillDirectories = await listDirectories(join(directory, 'skills'));
    return Promise.all(skillDirectories.map(async (name) => {
      const path = join(directory, 'skills', name, 'SKILL.md');
      const content = await readFile(path, 'utf8');
      const skill = SkillSchema.parse({ ...readFrontMatter(content), body: bodyOf(content) });
      if (skill.name !== name) {
        throw new Error(`技能目录与名称不一致：${name}`);
      }
      assertSkillBody(skill.body);
      const methodSources = await Promise.all(skill.methodSources.map((source) => this.deps.methodSources.resolve(source)));
      return {
        ...skill,
        registrySource,
        sha256: sha256(content),
        methodSources,
      };
    }));
  }

  private async readProfiles(
    directory: string,
    registrySource: { url: string; revision: string },
    skills: InstalledSkill[],
  ): Promise<InstalledWorkflowProfile[]> {
    const profileDirectories = await listDirectories(join(directory, 'profiles'));
    return Promise.all(profileDirectories.map(async (name) => {
      const path = join(directory, 'profiles', name, 'PROFILE.yaml');
      const content = await readFile(path, 'utf8');
      const profile = WorkflowProfileSchema.parse(parse(content));
      if (profile.name !== name) {
        throw new Error(`工作流模板目录与名称不一致：${name}`);
      }
      for (const [stage, reference] of Object.entries(profile.skills)) {
        const [skillName, version] = reference.split('@');
        const skill = skills.find((candidate) => candidate.name === skillName && candidate.version === version);
        if (skill === undefined || !skill.phases.includes(stage as typeof skill.phases[number]) || skill.methodSources.length === 0) {
          throw new Error(`工作流模板引用了不兼容技能：${stage}`);
        }
      }
      return { ...profile, registrySource, sha256: sha256(content) };
    }));
  }
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

function readFrontMatter(content: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (match === null) {
    throw new Error('SKILL.md 缺少 front matter');
  }
  const frontMatter = parse(match[1]);
  if (frontMatter === null || typeof frontMatter !== 'object' || Array.isArray(frontMatter)) {
    throw new Error('SKILL.md front matter 无效');
  }
  return frontMatter;
}

function bodyOf(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (match === null) {
    throw new Error('SKILL.md 缺少正文');
  }
  return match[1].trim();
}

function assertSkillBody(body: string): void {
  for (const heading of ['输入', '步骤', '验证']) {
    if (!new RegExp(`^#{1,6}\\s+${heading}\\s*$`, 'm').test(body)) {
      throw new Error(`SKILL.md 缺少「${heading}」章节`);
    }
  }
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
