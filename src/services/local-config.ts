import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const LocalConfigSchema = z.object({
  schemaVersion: z.literal('aiw.local/v1'),
  methodSources: z.record(z.string(), z.object({
    kind: z.literal('local-skill-directory'),
    root: z.string().min(1).refine(isAbsolute, '方法来源目录必须使用绝对路径'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    revision: z.string().min(1),
  })),
});

export type LocalMethodSourceProfile = z.infer<typeof LocalConfigSchema>['methodSources'][string];

export class LocalConfig {
  constructor(private readonly path: string) {}

  async methodSource(name: string): Promise<LocalMethodSourceProfile> {
    const config = LocalConfigSchema.parse(parse(await readFile(this.path, 'utf8')));
    const profile = config.methodSources[name];
    if (profile === undefined) {
      throw new Error('Method source is unavailable');
    }
    return profile;
  }
}
