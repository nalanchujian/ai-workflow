import { z } from 'zod';

const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

export const FactSourceSchema = z.object({
  type: z.literal('requirement'),
  path: z.string().regex(relativePathPattern, '事实来源必须是项目内相对路径'),
  locator: z.string().min(1).optional(),
}).strict();

export const FactItemSchema = z.object({
  statement: z.string().min(8),
  source: FactSourceSchema,
}).strict();

export const FactRegisterSchema = z.object({
  schemaVersion: z.literal('aiw.fact-register/v3'),
  facts: z.array(FactItemSchema).min(1),
}).strict();

export type FactItem = z.infer<typeof FactItemSchema>;
export type FactRegister = z.infer<typeof FactRegisterSchema>;
