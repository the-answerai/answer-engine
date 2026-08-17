import { z } from 'zod';
import { DigestReferenceSchema } from './release.js';

export const ReleaseStateSchema = z.object({
  schemaVersion: z.literal(1),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  current: DigestReferenceSchema,
  previous: DigestReferenceSchema,
  verifiedAtInstall: z.boolean(),
  lastAction: z.enum(['upgrade', 'rollback']).optional(),
  pending: z.object({
    action: z.enum(['upgrade', 'rollback']),
    from: DigestReferenceSchema,
    to: DigestReferenceSchema,
  }).strict().optional(),
}).strict();

export type ReleaseState = z.infer<typeof ReleaseStateSchema>;
