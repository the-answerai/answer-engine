import { z } from 'zod';

export const FirstImportSourceIdSchema = z.enum(['claude-code', 'codex', 'cowork']);
export const FirstImportStatusSchema = z.enum([
  'discovered', 'approved', 'running', 'cancel_requested', 'canceled', 'completed', 'failed',
]);
export const FirstImportOutcomeSchema = z.enum([
  'pending', 'imported', 'duplicate', 'failed', 'skipped',
]);

const NonEmptyStringSchema = z.string().trim().min(1).max(4_096);
const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const FirstImportDiscoverySchema = z.object({
  manifestPath: NonEmptyStringSchema,
  sources: z.array(z.object({
    sourceId: FirstImportSourceIdSchema,
    label: z.string().trim().min(1).max(120),
    paths: z.array(NonEmptyStringSchema).max(10_000),
    estimatedCount: z.number().int().nonnegative(),
    estimatedBytes: z.number().int().nonnegative(),
    privacyPosture: z.string().trim().min(1).max(1_000),
    exclusions: z.array(z.string().trim().min(1).max(500)).max(100),
    availability: z.enum(['available', 'not_found', 'unsupported_platform', 'unavailable']),
    availabilityNote: z.string().trim().min(1).max(500),
    items: z.array(z.object({
      fingerprint: FingerprintSchema,
      sourcePath: NonEmptyStringSchema,
      byteSize: z.number().int().nonnegative(),
      modifiedAt: z.string().datetime(),
    }).strict()).max(100_000),
  }).strict().superRefine((source, context) => {
    if (source.estimatedCount !== source.items.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['estimatedCount'],
        message: 'must equal the source item count',
      });
    }
    const bytes = source.items.reduce((total, item) => total + item.byteSize, 0);
    if (source.estimatedBytes !== bytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['estimatedBytes'],
        message: 'must equal the source item byte total',
      });
    }
  })).min(1).max(3),
}).strict().superRefine((value, context) => {
  if (new Set(value.sources.map((source) => source.sourceId)).size !== value.sources.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: 'source IDs must be unique' });
  }
});

export const FirstImportApprovalSchema = z.object({
  sourceIds: z.array(FirstImportSourceIdSchema).min(1).max(3),
}).strict().refine((value) => new Set(value.sourceIds).size === value.sourceIds.length, {
  message: 'source IDs must be unique',
});

export const FirstImportEventSchema = z.object({
  sourceId: FirstImportSourceIdSchema,
  fingerprint: FingerprintSchema,
  outcome: FirstImportOutcomeSchema.exclude(['pending']),
  contentIds: z.array(z.string().uuid()).max(100).optional(),
  archiveManifestPath: NonEmptyStringSchema.optional(),
  errorCode: z.string().regex(/^[A-Z0-9_]{2,80}$/).optional(),
  recoveryAction: z.string().trim().min(1).max(1_000).optional(),
}).strict().superRefine((event, context) => {
  if (event.outcome === 'imported' && (!event.contentIds?.length || !event.archiveManifestPath)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'imported events require contentIds and archiveManifestPath' });
  }
  if (event.outcome === 'failed' && (!event.errorCode || !event.recoveryAction)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'failed events require a safe errorCode and recoveryAction' });
  }
});

export type FirstImportStatus = z.infer<typeof FirstImportStatusSchema>;
export type FirstImportDiscovery = z.infer<typeof FirstImportDiscoverySchema>;
export type FirstImportApproval = z.infer<typeof FirstImportApprovalSchema>;
export type FirstImportEvent = z.infer<typeof FirstImportEventSchema>;

const LEGAL_TRANSITIONS: Record<FirstImportStatus, readonly FirstImportStatus[]> = {
  discovered: ['approved', 'canceled'],
  approved: ['running', 'canceled'],
  running: ['cancel_requested', 'completed', 'failed'],
  cancel_requested: ['canceled', 'completed', 'failed'],
  canceled: ['approved'],
  completed: [],
  failed: ['approved'],
};

export function assertFirstImportTransition(from: FirstImportStatus, to: FirstImportStatus): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new Error(`Cannot move first import from ${from} to ${to}`);
  }
}

export function reconcileFirstImportCounts(counts: {
  imported: number; duplicate: number; failed: number; skipped: number;
}) {
  return { discovered: counts.imported + counts.duplicate + counts.failed + counts.skipped, ...counts };
}
