import { z } from 'zod';

import { ResolvedMethodSourceSchema } from './method-source.js';
import { RegistrySourceSchema } from './task.js';

const revisionPattern = /^[a-f0-9]{40}$/;
const methodNamePattern = /^[a-z][a-z0-9-]*$/;

/**
 * `method-sources/<source>/<version>/SOURCE.yaml` 的受信任元数据。
 *
 * 团队技能包将第三方方法随包分发；该清单使每个已安装的方法都能追溯到
 * 上游版本与许可证，而不是依赖用户机器上的任意目录。
 */
export const BundledMethodManifestSchema = z.object({
  id: z.string().regex(methodNamePattern),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  upstream: z.object({
    url: z.string().url(),
    revision: z.string().regex(revisionPattern),
    license: z.string().min(1),
  }),
  methods: z.array(z.string().regex(methodNamePattern)).min(1),
}).superRefine((manifest, context) => {
  if (new Set(manifest.methods).size !== manifest.methods.length) {
    context.addIssue({ code: 'custom', path: ['methods'], message: '方法名称不得重复' });
  }
});

export const InstalledBundledMethodSchema = z.object({
  source: ResolvedMethodSourceSchema.refine((source) => source.source.startsWith('bundled:'), {
    message: '内置方法必须使用 bundled: 来源',
  }),
  content: z.string().min(1),
  registrySource: RegistrySourceSchema,
});

export type BundledMethodManifest = z.infer<typeof BundledMethodManifestSchema>;
export type InstalledBundledMethod = z.infer<typeof InstalledBundledMethodSchema>;
