import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

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
  }).default({}),
  workflow: DefaultWorkflowSchema.optional(),
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

  async updateDefaultWorkflowRef(ref: string): Promise<DefaultWorkflow> {
    if (ref.trim().length === 0) {
      throw new Error('技能版本不能为空');
    }
    const document = await this.read();
    const workflow = await this.defaultWorkflow();
    const updated = {
      ...workflow,
      defaultSkillSource: { ...workflow.defaultSkillSource, ref },
    };
    await writeFile(this.path, stringify({ ...document, workflow: updated }), 'utf8');
    return updated;
  }

  async read(): Promise<LocalConfigDocument> {
    return LocalConfigSchema.parse(parse(await readFile(this.path, 'utf8')));
  }
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
