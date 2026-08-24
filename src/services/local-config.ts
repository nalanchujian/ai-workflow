import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { DEFAULT_CONTEXT_TOKEN_BUDGET } from '../domain/context.js';
import type { DefaultWorkflow } from './default-workflow.js';

const DefaultWorkflowSchema = z.object({
  defaultSkillSource: z.object({
    url: z.string().url(),
    ref: z.string().min(1),
  }).strict(),
  defaultProfile: z.string().min(1),
}).strict();

const LocalConfigSchema = z.object({
  schemaVersion: z.literal('aiw.local/v1'),
  connectors: z.object({
    lark: z.object({
      configSource: z.object({ kind: z.literal('codex-toml'), path: z.string().min(1) }),
      server: z.string().min(1),
      tool: z.string().min(1),
      useUAT: z.boolean(),
    }).optional(),
    figma: z.object({
      configSource: z.object({ kind: z.literal('codex-toml'), path: z.string().min(1) }),
      server: z.string().min(1),
      tools: z.object({
        metadata: z.string().min(1),
        screenshot: z.string().min(1),
        designContext: z.string().min(1),
      }).strict(),
    }).strict().optional(),
  }).default({}),
  workflow: DefaultWorkflowSchema.optional(),
  context: z.object({
    maxTokens: z.number().int().min(1_000).max(200_000),
  }).default({ maxTokens: DEFAULT_CONTEXT_TOKEN_BUDGET }),
}).strict();

export type LocalConfigDocument = z.infer<typeof LocalConfigSchema>;
export type LocalLarkConnectorProfile = NonNullable<LocalConfigDocument['connectors']['lark']>;
export type LocalFigmaConnectorProfile = NonNullable<LocalConfigDocument['connectors']['figma']>;

export class LocalConfig {
  constructor(private readonly path: string) {}

  async larkConnector(): Promise<LocalLarkConnectorProfile> {
    const profile = (await this.read()).connectors.lark;
    if (profile === undefined) {
      throw new Error('Lark Connector is unavailable');
    }
    return {
      ...profile,
      configSource: { ...profile.configSource, path: expandHome(profile.configSource.path) },
    };
  }

  async figmaConnector(): Promise<LocalFigmaConnectorProfile> {
    const profile = (await this.read()).connectors.figma;
    if (profile === undefined) throw new Error('Figma Connector is unavailable');
    return {
      ...profile,
      configSource: { ...profile.configSource, path: expandHome(profile.configSource.path) },
    };
  }

  async defaultWorkflow(): Promise<DefaultWorkflow> {
    const workflow = (await this.read()).workflow;
    if (workflow === undefined) {
      throw new Error('未配置默认工作流，请先运行 aiw init');
    }
    return workflow;
  }

  async contextTokenBudget(): Promise<number> {
    try {
      return (await this.read()).context.maxTokens;
    } catch (error) {
      // The runtime can be composed in tests or by embedding callers before
      // `aiw init` has written a local config. The documented default remains
      // safe and deterministic in that case.
      if (isMissingFile(error)) return DEFAULT_CONTEXT_TOKEN_BUDGET;
      throw error;
    }
  }

  async updateDefaultWorkflow(input: { ref: string; profile: string }): Promise<DefaultWorkflow> {
    if (input.ref.trim().length === 0) {
      throw new Error('技能版本不能为空');
    }
    if (input.profile.trim().length === 0) {
      throw new Error('默认工作流模板不能为空');
    }
    const document = await this.read();
    const workflow = await this.defaultWorkflow();
    const updated = {
      ...workflow,
      defaultSkillSource: { ...workflow.defaultSkillSource, ref: input.ref },
      defaultProfile: input.profile,
    };
    await writeFile(this.path, stringify({ ...document, workflow: updated }), 'utf8');
    return updated;
  }

  async updateLarkConnector(profile: LocalLarkConnectorProfile): Promise<void> {
    const document = await this.read();
    await writeFile(this.path, stringify({
      ...document,
      connectors: { ...document.connectors, lark: profile },
    }), 'utf8');
  }

  async read(): Promise<LocalConfigDocument> {
    return LocalConfigSchema.parse(parse(await readFile(this.path, 'utf8')));
  }
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
