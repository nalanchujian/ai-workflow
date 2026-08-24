import { z } from 'zod';

import { RegistrySourceSchema } from './task.js';
import { OutputContractVersion, SupportedAiwCompatibility } from './output-contract.js';

export const requiredExecutableStages = ['clarify', 'solution', 'plan', 'development'] as const;
export const executableStages = ['design', ...requiredExecutableStages] as const;

export const WorkflowProfileSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(1).refine((value) => !value.includes('\n')),
  aiwCompatibility: z.literal(SupportedAiwCompatibility),
  artifactContract: z.literal(OutputContractVersion),
  skills: z.object({
    design: z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/).optional(),
    clarify: z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/),
    solution: z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/),
    plan: z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/),
    development: z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/),
  }),
});

export const InstalledWorkflowProfileSchema = WorkflowProfileSchema.extend({
  registrySource: RegistrySourceSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type WorkflowProfile = z.infer<typeof WorkflowProfileSchema>;
export type InstalledWorkflowProfile = z.infer<typeof InstalledWorkflowProfileSchema>;
