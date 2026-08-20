import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

import { parseVerificationCommand } from '../domain/verification-command.js';
import type { ProcessRunner } from '../ports/process-runner.js';
import { minimalChildEnvironment } from '../adapters/child-process-environment.js';
import { AcceptanceEvidenceTypeSchema, type AcceptanceEvidenceType } from '../domain/acceptance-evidence.js';
import type { VerificationProfileRef } from '../domain/verification-profile.js';

const profileId = /^[a-z][a-z0-9-]{0,40}$/;

const ProjectTestProfileSchema = z.object({
  id: z.string().regex(profileId, '测试能力 ID 格式无效'),
  title: z.string().min(1),
  command: z.string().min(1),
  healthCheck: z.string().min(1),
  targetMode: z.enum(['append', 'none']),
  evidenceTypes: z.array(AcceptanceEvidenceTypeSchema).min(1),
}).strict();

const ProjectConfigTestingSchema = z.object({
  schemaVersion: z.literal('aiw.config/v1'),
  testing: z.object({
    profiles: z.array(ProjectTestProfileSchema).min(1),
  }).optional(),
}).passthrough();

export type ProjectTestProfile = z.infer<typeof ProjectTestProfileSchema>;
export { VerificationProfileRefSchema, type VerificationProfileRef } from '../domain/verification-profile.js';
export type ResolvedVerification = {
  profile: string;
  evidenceType: AcceptanceEvidenceType;
  acceptanceRefs: string[];
  command: string;
};

export class ProjectTestProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectTestProfileError';
  }
}

/**
 * Project test capabilities are trusted project configuration or conservative
 * discovery, never arbitrary strings created by the planning model.
 */
export class ProjectTestProfiles {
  constructor(private readonly deps: { processRunner?: ProcessRunner; timeoutMs?: number } = {}) {}

  async list(projectRoot: string): Promise<ProjectTestProfile[]> {
    const configured = await readConfiguredProfiles(projectRoot);
    const profiles = configured ?? await discoverProfiles(projectRoot);
    const ids = new Set(profiles.map((profile) => profile.id));
    if (ids.size !== profiles.length) throw new ProjectTestProfileError('项目测试能力配置包含重复 ID');
    for (const profile of profiles) {
      try {
        parseVerificationCommand(profile.command);
        parseVerificationCommand(profile.healthCheck);
      } catch (error) {
        throw new ProjectTestProfileError(`项目测试能力 ${profile.id} 配置无效：${error instanceof Error ? error.message : '命令格式无效'}`);
      }
    }
    return profiles;
  }

  async resolve(projectRoot: string, refs: VerificationProfileRef[]): Promise<ResolvedVerification[]> {
    const profiles = new Map((await this.list(projectRoot)).map((profile) => [profile.id, profile]));
    const commands = refs.map((ref) => {
      const profile = profiles.get(ref.profile);
      if (profile === undefined) throw new ProjectTestProfileError(`项目未提供测试能力：${ref.profile}。请在 .aiw/config.yaml 的 testing.profiles 中配置，或选择 AIW 已发现的测试能力。`);
      if (!profile.evidenceTypes.includes(ref.evidenceType)) {
        throw new ProjectTestProfileError(`测试能力 ${profile.id} 不支持 ${ref.evidenceType} 证据；它只支持 ${profile.evidenceTypes.join('、')}`);
      }
      if (profile.targetMode === 'none' && ref.targets.length > 0) {
        throw new ProjectTestProfileError(`测试能力 ${profile.id} 不接受 targets；请移除 targets。`);
      }
      const command = profile.targetMode === 'append' && ref.targets.length > 0
        ? `${profile.command} ${ref.targets.join(' ')}`
        : profile.command;
      return { profile: profile.id, evidenceType: ref.evidenceType, acceptanceRefs: ref.acceptanceRefs, command };
    });
    if (new Set(commands.map((item) => `${item.command}:${item.evidenceType}:${item.acceptanceRefs.join(',')}`)).size !== commands.length) {
      throw new ProjectTestProfileError('同一工作单元不能重复声明相同验收测试绑定');
    }
    return commands;
  }

  async assertHealthy(projectRoot: string, refs: VerificationProfileRef[]): Promise<void> {
    if (this.deps.processRunner === undefined) return;
    const profiles = new Map((await this.list(projectRoot)).map((profile) => [profile.id, profile]));
    const used = [...new Set(refs.map((ref) => ref.profile))];
    for (const id of used) {
      const profile = profiles.get(id);
      if (profile === undefined) throw new ProjectTestProfileError(`项目未提供测试能力：${id}`);
      const invocation = parseVerificationCommand(profile.healthCheck);
      let result;
      try {
        result = await this.deps.processRunner.run({
          ...invocation,
          cwd: projectRoot,
          stdin: '',
          timeoutMs: this.deps.timeoutMs ?? 60_000,
          env: minimalChildEnvironment(),
        });
      } catch (error) {
        throw new ProjectTestProfileError(`测试能力 ${id} 无法启动：${error instanceof Error ? error.message : '未知错误'}`);
      }
      if (result.exitCode !== 0 || result.timedOut || result.signal !== null) {
        const detail = compactOutput(result.stderr || result.stdout);
        throw new ProjectTestProfileError(`测试能力 ${id} 当前不可用，健康检查失败：${profile.healthCheck}${detail === '' ? '' : `（${detail}）`}。请先修复项目测试环境，再重新生成计划。`);
      }
    }
  }
}

async function readConfiguredProfiles(projectRoot: string): Promise<ProjectTestProfile[] | undefined> {
  try {
    const content = await readFile(join(projectRoot, '.aiw', 'config.yaml'), 'utf8');
    const config = ProjectConfigTestingSchema.parse(parse(content));
    return config.testing?.profiles;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new ProjectTestProfileError(`无法读取项目测试能力配置：${error instanceof Error ? error.message : '配置无效'}`);
  }
}

async function discoverProfiles(projectRoot: string): Promise<ProjectTestProfile[]> {
  try {
    const packageJson = z.object({
      devDependencies: z.record(z.string(), z.string()).optional(),
      dependencies: z.record(z.string(), z.string()).optional(),
    }).passthrough().parse(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')));
    const dependencies = new Set([...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})]);
    const profiles: ProjectTestProfile[] = [];
    if (dependencies.has('vitest')) profiles.push({ id: 'vitest', title: 'Vitest 测试', command: 'pnpm exec vitest run', healthCheck: 'pnpm exec vitest --version', targetMode: 'append', evidenceTypes: dependencies.has('@testing-library/react') ? ['unit', 'component'] : ['unit'] });
    if (dependencies.has('jest')) profiles.push({ id: 'jest', title: 'Jest 测试', command: 'pnpm exec jest --runInBand', healthCheck: 'pnpm exec jest --version', targetMode: 'append', evidenceTypes: dependencies.has('@testing-library/react') ? ['unit', 'component'] : ['unit'] });
    if (dependencies.has('@playwright/test')) profiles.push({ id: 'playwright', title: 'Playwright 浏览器测试', command: 'pnpm exec playwright test', healthCheck: 'pnpm exec playwright --version', targetMode: 'append', evidenceTypes: ['browser'] });
    return profiles;
  } catch (error) {
    // A repository without package.json is not a production Node project, but
    // keeping this deterministic fallback lets embedders supply a ProcessRunner
    // in isolated tests. Real projects with a package.json must expose a
    // discovered runner or an explicit .aiw testing profile.
    if (isMissing(error)) return [{ id: 'vitest', title: 'Vitest 单元测试', command: 'pnpm exec vitest run', healthCheck: 'pnpm exec vitest --version', targetMode: 'append', evidenceTypes: ['unit'] }];
    throw new ProjectTestProfileError(`无法读取项目 package.json 以发现测试能力：${error instanceof Error ? error.message : '未知错误'}`);
  }
}

function compactOutput(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
