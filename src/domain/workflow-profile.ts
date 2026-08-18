import { z } from 'zod';

import { RegistrySourceSchema } from './task.js';

const stageKeys = ['clarify', 'solution', 'plan', 'implement'] as const;

export const WorkflowProfileSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(1).refine((value) => !value.includes('\n')),
  skills: z.object({
    clarify: z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/),
    solution: z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/),
    plan: z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/),
    implement: z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/),
  }),
});

export const InstalledWorkflowProfileSchema = WorkflowProfileSchema.extend({
  registrySource: RegistrySourceSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const executableStages = stageKeys;
export type WorkflowProfile = z.infer<typeof WorkflowProfileSchema>;
export type InstalledWorkflowProfile = z.infer<typeof InstalledWorkflowProfileSchema>;
