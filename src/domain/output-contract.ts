import { z } from 'zod';

/**
 * The platform, rather than a skill, owns every physical task-artifact path.
 * Codex writes only to a per-run staging location; AIW validates and promotes
 * those files into the current task result after the process exits.
 */
export const OutputContractVersion = 'aiw.task-output/v1' as const;
/** The current CLI major and artifact protocol understood by this runtime. */
export const SupportedAiwCompatibility = '>=0.0.1 <1.0.0' as const;

export const OutputContractEntrySchema = z.object({
  finalPath: z.string().min(1),
  stagingPath: z.string().min(1),
}).strict();

export const OutputContractSchema = z.object({
  schemaVersion: z.literal(OutputContractVersion),
  entries: z.array(OutputContractEntrySchema).min(1),
}).strict().superRefine((contract, context) => {
  const finalPaths = new Set<string>();
  const stagingPaths = new Set<string>();
  for (const [index, entry] of contract.entries.entries()) {
    if (finalPaths.has(entry.finalPath)) {
      context.addIssue({ code: 'custom', path: ['entries', index, 'finalPath'], message: '正式产物路径不能重复' });
    }
    if (stagingPaths.has(entry.stagingPath)) {
      context.addIssue({ code: 'custom', path: ['entries', index, 'stagingPath'], message: '暂存产物路径不能重复' });
    }
    finalPaths.add(entry.finalPath);
    stagingPaths.add(entry.stagingPath);
  }
});

export type OutputContract = z.infer<typeof OutputContractSchema>;

export function stagingOutputPath(runId: string, finalPath: string): string {
  return `runs/${runId}/staging/${finalPath}`;
}

export function outputContractFor(runId: string, finalPaths: string[]): OutputContract {
  return OutputContractSchema.parse({
    schemaVersion: OutputContractVersion,
    entries: finalPaths.map((finalPath) => ({
      finalPath,
      stagingPath: stagingOutputPath(runId, finalPath),
    })),
  });
}

export function codexOutputEntries(contract: OutputContract): OutputContract['entries'] {
  return contract.entries;
}
