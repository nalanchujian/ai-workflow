import { z } from 'zod';

import { PhaseSchema, RegistrySourceSchema } from './task.js';
import { OutputContractVersion, SupportedAiwCompatibility } from './output-contract.js';

export const SkillSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(1).refine((value) => !value.includes('\n')),
  aiwCompatibility: z.literal(SupportedAiwCompatibility),
  artifactContract: z.literal(OutputContractVersion),
  phases: z.array(PhaseSchema).min(1),
  body: z.string().min(1),
});

export const InstalledSkillSchema = SkillSchema.extend({
  registrySource: RegistrySourceSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type Skill = z.infer<typeof SkillSchema>;
export type InstalledSkill = z.infer<typeof InstalledSkillSchema>;
