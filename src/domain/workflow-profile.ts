import { z } from 'zod';

import { RegistrySourceSchema } from './task.js';
import { OutputContractVersion, SupportedAiwCompatibility } from './output-contract.js';

export const requiredExecutableStages = ['requirement-analysis', 'solution', 'plan', 'development'] as const;
export const executableStages = [...requiredExecutableStages, 'api-analysis', 'design-slicing'] as const;
const SkillReferencesSchema = z.array(z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/)).min(1)
  .refine((references) => new Set(references).size === references.length, '阶段技能引用不得重复');

export const WorkflowProfileSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().min(1).refine((value) => !value.includes('\n')),
  aiwCompatibility: z.literal(SupportedAiwCompatibility),
  artifactContract: z.literal(OutputContractVersion),
  skills: z.object({
    'api-analysis': SkillReferencesSchema,
    'design-slicing': SkillReferencesSchema,
    'requirement-analysis': SkillReferencesSchema,
    solution: SkillReferencesSchema,
    plan: SkillReferencesSchema,
    development: SkillReferencesSchema,
  }).strict(),
}).strict();

export const InstalledWorkflowProfileSchema = WorkflowProfileSchema.extend({
  registrySource: RegistrySourceSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type WorkflowProfile = z.infer<typeof WorkflowProfileSchema>;
export type InstalledWorkflowProfile = z.infer<typeof InstalledWorkflowProfileSchema>;
