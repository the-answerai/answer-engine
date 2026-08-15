import { z } from 'zod';

const PathSchema = z.string().trim().min(1).max(4_096);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ErrorCodeSchema = z.string().regex(/^[A-Z0-9_]{2,80}$/);

export const FolderDispositionSchema = z.enum([
  'candidate', 'excluded', 'hidden', 'unsupported', 'binary', 'too_large',
  'access_denied', 'symlink', 'aggregate_limit', 'missing',
]);
export const FolderOutcomeSchema = z.enum([
  'pending', 'imported', 'updated', 'duplicate', 'excluded', 'changed',
  'failed', 'skipped', 'missing',
]);
export const FolderRunStatusSchema = z.enum([
  'previewed', 'approved', 'running', 'cancel_requested', 'canceled', 'completed', 'failed',
]);

export const FolderInventoryItemSchema = z.object({
  sourcePath: PathSchema,
  relativePath: PathSchema,
  fileType: z.string().trim().min(1).max(120).optional(),
  byteSize: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime().optional(),
  disposition: FolderDispositionSchema,
  reason: z.string().trim().min(1).max(1_000),
  metadataFingerprint: Sha256Schema.optional(),
  change: z.enum(['added', 'changed', 'unchanged', 'missing', 'excluded']).optional(),
}).strict().superRefine((item, context) => {
  if (item.disposition === 'candidate' && (!item.modifiedAt || !item.metadataFingerprint)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'candidate files require modifiedAt and metadataFingerprint' });
  }
});

const InventorySchema = z.array(FolderInventoryItemSchema).max(100_000).superRefine((items, context) => {
  if (new Set(items.map((item) => item.relativePath)).size !== items.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'relative paths must be unique' });
  }
});

export const FolderSourceDiscoverySchema = z.object({
  rootPath: PathSchema,
  libraryId: z.string().uuid().optional(),
  includePatterns: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  excludePatterns: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  maxFileBytes: z.number().int().positive().max(1_073_741_824),
  maxTotalBytes: z.number().int().positive().max(10_737_418_240),
  symlinkPolicy: z.literal('no_follow'),
  manifestPath: PathSchema,
  inventory: InventorySchema,
}).strict().superRefine((value, context) => {
  let approvedBytes = 0;
  for (const [index, item] of value.inventory.entries()) {
    if (item.disposition !== 'candidate') continue;
    approvedBytes += item.byteSize;
    if (item.byteSize > value.maxFileBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inventory', index, 'byteSize'],
        message: 'candidate bytes exceed maxFileBytes',
      });
    }
  }
  if (approvedBytes > value.maxTotalBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['inventory'], message: 'candidate bytes exceed maxTotalBytes' });
  }
});

export const FolderRefreshDiscoverySchema = z.object({
  manifestPath: PathSchema,
  inventory: InventorySchema,
}).strict();

export const FolderIngestionEventSchema = z.object({
  relativePath: PathSchema,
  outcome: FolderOutcomeSchema.exclude(['pending']),
  appliedSha256: Sha256Schema.optional(),
  contentId: z.string().uuid().optional(),
  archiveManifestPath: PathSchema.optional(),
  errorCode: ErrorCodeSchema.optional(),
  recoveryAction: z.string().trim().min(1).max(1_000).optional(),
}).strict().superRefine((event, context) => {
  if (['imported', 'updated'].includes(event.outcome)
    && (!event.appliedSha256 || !event.contentId || !event.archiveManifestPath)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'applied outcomes require SHA-256, contentId, and archiveManifestPath' });
  }
  if (event.outcome === 'failed' && (!event.errorCode || !event.recoveryAction)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'failed outcomes require an errorCode and recoveryAction' });
  }
});

export const FolderRemovalSchema = z.object({ retention: z.enum(['keep', 'delete']) }).strict();
export const FolderRemovalCompleteSchema = FolderRemovalSchema.extend({
  deletedContentIds: z.array(z.string().uuid()).max(100_000).default([]),
  archivesRemoved: z.number().int().nonnegative().default(0),
  failures: z.array(z.object({ path: PathSchema, errorCode: ErrorCodeSchema }).strict()).max(10_000).default([]),
}).strict();

export type FolderSourceDiscovery = z.infer<typeof FolderSourceDiscoverySchema>;
export type FolderRefreshDiscovery = z.infer<typeof FolderRefreshDiscoverySchema>;
export type FolderIngestionEvent = z.infer<typeof FolderIngestionEventSchema>;
export type FolderRunStatus = z.infer<typeof FolderRunStatusSchema>;
export type FolderRemoval = z.infer<typeof FolderRemovalSchema>;
export type FolderRemovalComplete = z.infer<typeof FolderRemovalCompleteSchema>;

const LEGAL_RUN_TRANSITIONS: Record<FolderRunStatus, readonly FolderRunStatus[]> = {
  previewed: ['approved', 'canceled'],
  approved: ['running', 'canceled'],
  running: ['cancel_requested', 'completed', 'failed'],
  cancel_requested: ['canceled', 'completed', 'failed'],
  canceled: ['approved'],
  completed: [],
  failed: ['approved'],
};

export function assertFolderRunTransition(from: FolderRunStatus, to: FolderRunStatus): void {
  if (!LEGAL_RUN_TRANSITIONS[from].includes(to)) {
    throw new Error(`Cannot move folder ingestion from ${from} to ${to}`);
  }
}

export function reconcileFolderInventory(items: ReadonlyArray<{ outcome: z.infer<typeof FolderOutcomeSchema> }>) {
  const counts = {
    imported: 0, updated: 0, duplicate: 0, excluded: 0, changed: 0,
    failed: 0, skipped: 0, missing: 0, pending: 0,
  };
  for (const item of items) counts[item.outcome] += 1;
  return { previewed: items.length, ...counts };
}
