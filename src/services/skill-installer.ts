import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

import { SkillSchema, type InstalledSkill } from '../domain/skill.js';
import { WorkflowProfileSchema, type InstalledWorkflowProfile } from '../domain/workflow-profile.js';
import type { GitClient } from '../ports/git-client.js';
import { SkillRegistry } from './skill-registry.js';

export interface InstallResult {
  skills: InstalledSkill[];
  profiles: InstalledWorkflowProfile[];
}

export class SkillInstaller {
  constructor(private readonly deps: { git: GitClient; registry: SkillRegistry }) {}

  async install(input: { url: string; ref?: string }): Promise<InstallResult> {
    assertSupportedGitUrl(input.url);
    const cloned = await this.deps.git.clone(input);
    const registrySource = { url: input.url, revision: cloned.revision };
    const skills = await this.readSkills(cloned.directory, registrySource);
    const existing = await this.deps.registry.snapshotForInstall();
    const profiles = await this.readProfiles(
      cloned.directory,
      registrySource,
      [...existing.skills.filter((skill) => skill.registrySource.url !== input.url), ...skills],
    );
    if (skills.length === 0 && profiles.length === 0) {
      throw new Error('技能包未包含有效技能或工作流模板');
    }
    await this.deps.registry.replaceSource(
      { sourceUrl: input.url, skills, profiles },
      { recoverInvalidRegistry: existing.recoveredInvalidRegistry },
    );
    return { skills, profiles };
  }

  private async readSkills(
    directory: string,
    registrySource: { url: string; revision: string },
  ): Promise<InstalledSkill[]> {
    const skillDirectories = await listDirectories(join(directory, 'skills'));
    const skills = await Promise.all(skillDirectories.map(async (name) => {
      const path = join(directory, 'skills', name, 'SKILL.md');
      const content = await readFile(path, 'utf8');
      const frontMatter = readFrontMatter(content);
      if ('methodSources' in frontMatter) throw new Error(`技能 ${name} 不支持第三方方法来源；请将方法完整实现为自定义技能正文`);
      const skill = SkillSchema.parse({ ...frontMatter, body: bodyOf(content) });
      if (skill.name !== name) {
        throw new Error(`技能目录与名称不一致：${name}`);
      }
      assertSkillBody(skill.body);
      assertNoPlatformPathInstructions(skill.body, `技能 ${name}`);
      return {
        ...skill,
        registrySource,
        sha256: sha256(content),
      };
    }));
    return skills;
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
      for (const [stage, references] of Object.entries(profile.skills)) {
        for (const reference of references) {
          const [skillName, version] = reference.split('@');
          const skill = skills.find((candidate) => candidate.name === skillName && candidate.version === version);
          if (skill === undefined || !skill.phases.includes(stage as typeof skill.phases[number])) {
            throw new Error(`工作流模板引用了不兼容技能：${stage}`);
          }
        }
      }
      return { ...profile, registrySource, sha256: sha256(content) };
    }));
  }
}

function assertSupportedGitUrl(value: string): void {
  if (isHttpsGitUrl(value) || isSshGitUrl(value)) {
    return;
  }
  throw new Error('技能包来源仅支持 HTTPS 或 SSH Git URL');
}

function isHttpsGitUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.length > 0
      && url.username.length === 0
      && url.password.length === 0;
  } catch {
    return false;
  }
}

function isSshGitUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'ssh:') {
      return url.hostname.length > 0 && url.password.length === 0;
    }
  } catch {
    // Git 的 scp 风格 SSH 地址（git@example.com:team/skills.git）不是标准 URL。
  }
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value);
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
  for (const heading of ['输入', '步骤', '输出']) {
    if (!new RegExp(`^#{1,6}\\s+${heading}\\s*$`, 'm').test(body)) {
      throw new Error(`SKILL.md 缺少「${heading}」章节`);
    }
  }
}

/**
 * Paths, revisions and result ownership are generated by AIW for each run.
 * A method or skill may describe the result it wants, but cannot make a
 * competing filesystem contract that becomes stale after a platform release.
 */
function assertNoPlatformPathInstructions(body: string, label: string): void {
  const match = /(?:^|[\s`])((?:\.aiw\/|artifacts\/|runs\/)[^\s`)]*)/m.exec(body);
  if (match !== null) {
    throw new Error(`${label} 不得固化 AIW 平台路径：${match[1]}。请改为引用本次运行的 AIW 输出回执。`);
  }
  const protocolCopy = [
    /\bschemaVersion\b/,
    /```ya?ml\b/i,
    /\b(?:development-plan|fact-register|decision-register)\.ya?ml\b/i,
  ].find((pattern) => pattern.test(body));
  if (protocolCopy !== undefined) {
    throw new Error(`${label} 不得复制 AIW 产物协议。字段、枚举和示例由运行时 Zod Schema 生成。`);
  }
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
