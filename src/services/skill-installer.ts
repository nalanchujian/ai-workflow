import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

import { BundledMethodManifestSchema, type InstalledBundledMethod } from '../domain/bundled-method-source.js';
import { SkillSchema, type InstalledSkill } from '../domain/skill.js';
import type { MethodSource, ResolvedMethodSource } from '../domain/method-source.js';
import { WorkflowProfileSchema, type InstalledWorkflowProfile } from '../domain/workflow-profile.js';
import type { GitClient } from '../ports/git-client.js';
import { SkillRegistry } from './skill-registry.js';

export interface InstallResult {
  skills: InstalledSkill[];
  profiles: InstalledWorkflowProfile[];
  methods: InstalledBundledMethod[];
}

export class SkillInstaller {
  constructor(private readonly deps: { git: GitClient; registry: SkillRegistry }) {}

  async install(input: { url: string; ref?: string }): Promise<InstallResult> {
    assertSupportedGitUrl(input.url);
    const cloned = await this.deps.git.clone(input);
    const registrySource = { url: input.url, revision: cloned.revision };
    const bundledMethods = await this.readBundledMethods(cloned.directory, registrySource);
    const skills = await this.readSkills(cloned.directory, registrySource, bundledMethods);
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
      { sourceUrl: input.url, skills, profiles, methods: bundledMethods },
      { recoverInvalidRegistry: existing.recoveredInvalidRegistry },
    );
    return { skills, profiles, methods: bundledMethods };
  }

  private async readSkills(
    directory: string,
    registrySource: { url: string; revision: string },
    bundledMethods: InstalledBundledMethod[],
  ): Promise<InstalledSkill[]> {
    const skillDirectories = await listDirectories(join(directory, 'skills'));
    const skills = await Promise.all(skillDirectories.map(async (name) => {
      const path = join(directory, 'skills', name, 'SKILL.md');
      const content = await readFile(path, 'utf8');
      const skill = SkillSchema.parse({ ...readFrontMatter(content), body: bodyOf(content) });
      if (skill.name !== name) {
        throw new Error(`技能目录与名称不一致：${name}`);
      }
      assertSkillBody(skill.body);
      assertNoPlatformPathInstructions(skill.body, `技能 ${name}`);
      const methodSources = await Promise.all(skill.methodSources.map((source) => this.resolveMethodSource(source, bundledMethods)));
      return {
        ...skill,
        registrySource,
        sha256: sha256(content),
        methodSources,
      };
    }));
    return skills;
  }

  private async resolveMethodSource(source: MethodSource, bundledMethods: InstalledBundledMethod[]): Promise<ResolvedMethodSource> {
    if (!source.source.startsWith('bundled:')) {
      throw new Error(`团队技能包只支持内置方法来源：${source.source}`);
    }
    const method = bundledMethods.find((candidate) => (
      candidate.source.id === source.id
      && candidate.source.source === source.source
      && candidate.source.version === source.version
    ));
    if (method === undefined) {
      throw new Error(`团队技能包未提供声明的方法来源：${source.id}@${source.version}`);
    }
    return method.source;
  }

  private async readBundledMethods(
    directory: string,
    registrySource: { url: string; revision: string },
  ): Promise<InstalledBundledMethod[]> {
    const sourceDirectories = await listDirectories(join(directory, 'method-sources'));
    const bundles = await Promise.all(sourceDirectories.map(async (sourceName) => {
      const versions = await listDirectories(join(directory, 'method-sources', sourceName));
      return Promise.all(versions.map(async (version) => {
        const root = join(directory, 'method-sources', sourceName, version);
        const manifest = BundledMethodManifestSchema.parse(parse(await readFile(join(root, 'SOURCE.yaml'), 'utf8')));
        if (manifest.id !== sourceName || manifest.version !== version) {
          throw new Error(`内置方法目录与 SOURCE.yaml 不一致：${sourceName}@${version}`);
        }
        return Promise.all(manifest.methods.map(async (name) => {
          const content = await readFile(join(root, name, 'SKILL.md'), 'utf8');
          assertMethodName(content, name);
          assertNoPlatformPathInstructions(bodyOf(content), `内置方法 ${manifest.id}:${name}`);
          return {
            source: {
              id: `${manifest.id}:${name}`,
              source: `bundled:${manifest.id}`,
              version: manifest.version,
              revision: manifest.upstream.revision,
              sha256: sha256(content),
            },
            content,
            registrySource,
          };
        }));
      }));
    }));
    return bundles.flat(2);
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
  for (const heading of ['输入', '步骤', '验证']) {
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
  const match = /(?:^|[\s`])((?:\.aiw\/|artifacts\/|handoffs\/|runs\/)[^\s`)]*)/m.exec(body);
  if (match !== null) {
    throw new Error(`${label} 不得固化 AIW 平台路径：${match[1]}。请改为引用本次运行的 AIW 输出回执。`);
  }
}

function assertMethodName(content: string, expectedName: string): void {
  const frontMatter = readFrontMatter(content);
  if (frontMatter.name !== expectedName) {
    throw new Error(`方法来源入口与声明不一致：${expectedName}`);
  }
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
