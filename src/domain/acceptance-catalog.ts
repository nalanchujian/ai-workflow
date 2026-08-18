import { z } from 'zod';

const acceptanceIdPattern = /^AC-\d{2,}$/;

export const AcceptanceCatalogSchema = z.object({
  schemaVersion: z.literal('aiw.acceptance-catalog/v1'),
  items: z.array(z.object({
    id: z.string().regex(acceptanceIdPattern, '验收项 ID 格式无效'),
    title: z.string().min(1),
    description: z.string().min(8),
    factRefs: z.array(z.string().regex(/^FACT-[A-Z0-9-]+$/, '事实引用格式无效')).min(1),
  }).strict()).min(1),
}).strict().superRefine((catalog, context) => {
  const ids = new Set(catalog.items.map((item) => item.id));
  if (ids.size !== catalog.items.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: '验收项 ID 必须唯一' });
  }
});

export type AcceptanceCatalog = z.infer<typeof AcceptanceCatalogSchema>;
