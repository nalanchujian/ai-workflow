import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

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

  async read(): Promise<LocalConfigDocument> {
    return LocalConfigSchema.parse(parse(await readFile(this.path, 'utf8')));
  }
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
