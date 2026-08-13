import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const LocalConfigSchema = z.object({
  schemaVersion: z.literal('aiw.local/v1'),
  methodSources: z.record(z.string(), z.object({
    kind: z.literal('local-skill-directory'),
    root: z.string().min(1).refine(isAbsolute, '方法来源目录必须使用绝对路径'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    revision: z.string().min(1),
  })).default({}),
  connectors: z.object({
    lark: z.object({
      configSource: z.object({ kind: z.literal('codex-toml'), path: z.string().min(1) }),
      server: z.string().min(1),
      tool: z.string().min(1),
      useUAT: z.boolean(),
    }).optional(),
  }).default({}),
});

export type LocalMethodSourceProfile = z.infer<typeof LocalConfigSchema>['methodSources'][string];
export type LocalLarkConnectorProfile = NonNullable<z.infer<typeof LocalConfigSchema>['connectors']['lark']>;

export class LocalConfig {
  constructor(private readonly path: string) {}

  async methodSource(name: string): Promise<LocalMethodSourceProfile> {
    const config = await this.read();
    const profile = config.methodSources[name];
    if (profile === undefined) {
      throw new Error('Method source is unavailable');
    }
    return profile;
  }

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

  private async read(): Promise<z.infer<typeof LocalConfigSchema>> {
    return LocalConfigSchema.parse(parse(await readFile(this.path, 'utf8')));
  }
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
