import { readFile, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { DEFAULT_CONTEXT_TOKEN_BUDGET } from '../domain/context.js';
import type { DefaultWorkflow } from './default-workflow.js';

const DefaultWorkflowSchema = z.object({
  defaultSkillSource: z.object({
    url: z.string().url(),
    ref: z.string().min(1),
  }).strict(),
  defaultProfile: z.string().regex(/^[a-z][a-z0-9-]*$/, '默认工作流只允许使用模板名称'),
}).strict();

const LocalConfigSchema = z.object({
  schemaVersion: z.literal('aiw.local/v1'),
  connectors: z.object({
    lark: z.object({
      appId: z.string().min(1),
      domain: z.string().url(),
      callback: z.object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65_535),
      }).strict(),
    }).strict().optional(),
  }).strict().default({}),
  workflow: DefaultWorkflowSchema.optional(),
  context: z.object({
    maxTokens: z.number().int().min(1_000).max(200_000),
  }).default({ maxTokens: DEFAULT_CONTEXT_TOKEN_BUDGET }),
}).strict();

export type LocalConfigDocument = z.infer<typeof LocalConfigSchema>;
export type LocalLarkConnectorProfile = NonNullable<LocalConfigDocument['connectors']['lark']>;

export class LocalConfig {
  constructor(private readonly path: string) {}

  async larkConnector(): Promise<LocalLarkConnectorProfile> {
    const profile = (await this.read()).connectors.lark;
    if (profile === undefined) {
      throw new Error('Lark Connector is unavailable');
    }
    return profile;
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
    const raw = parse(await readFile(this.path, 'utf8'));
    if (!isRecord(raw) || Array.isArray(raw)) throw new Error('无法读取 AIW 本机设置');
    const connectors = isRecord(raw.connectors) && !Array.isArray(raw.connectors) ? raw.connectors : {};
    const document = LocalConfigSchema.parse({
      ...raw,
      connectors: { ...connectors, lark: profile },
    });
    await writeFile(this.path, stringify({
      ...document,
      connectors: { ...document.connectors, lark: profile },
    }), 'utf8');
  }

  async read(): Promise<LocalConfigDocument> {
    return LocalConfigSchema.parse(parse(await readFile(this.path, 'utf8')));
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
