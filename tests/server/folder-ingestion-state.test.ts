import { describe, expect, it } from 'vitest';
import {
  assertFolderRunTransition,
  FolderIngestionEventSchema,
  FolderSourceDiscoverySchema,
  reconcileFolderInventory,
} from '../../src/services/folder-ingestion/folder-ingestion-schemas.js';

describe('folder ingestion state', () => {
  it('requires explicit approval before a preview can run', () => {
    expect(() => assertFolderRunTransition('previewed', 'running')).toThrow(
      'Cannot move folder ingestion from previewed to running',
    );
    expect(() => assertFolderRunTransition('previewed', 'approved')).not.toThrow();
  });

  it('validates candidate metadata and aggregate safety limits', () => {
    const base = {
      rootPath: '/selected/notes', includePatterns: ['**/*.md'], excludePatterns: [],
      maxFileBytes: 100, maxTotalBytes: 5, symlinkPolicy: 'no_follow' as const,
      manifestPath: '/channel/data/folder-ingestion/preview.json',
    };
    expect(FolderSourceDiscoverySchema.safeParse({ ...base, inventory: [{ sourcePath: '/selected/notes/a.md',
      relativePath: 'a.md', byteSize: 6, disposition: 'candidate', reason: 'supported',
      modifiedAt: '2026-08-15T12:00:00.000Z', metadataFingerprint: 'a'.repeat(64) }] }).success).toBe(false);
    expect(FolderSourceDiscoverySchema.safeParse({ ...base, inventory: [{ sourcePath: '/selected/notes/link.md',
      relativePath: 'link.md', byteSize: 0, disposition: 'symlink', reason: 'not followed' }] }).success).toBe(true);
    expect(FolderSourceDiscoverySchema.safeParse({ ...base, maxTotalBytes: 1_000, inventory: [{
      sourcePath: '/selected/notes/oversized.md', relativePath: 'oversized.md', byteSize: 101,
      disposition: 'candidate', reason: 'supported', modifiedAt: '2026-08-15T12:00:00.000Z',
      metadataFingerprint: 'b'.repeat(64),
    }] }).success).toBe(false);
  });

  it('requires complete archive lineage for applied events and reconciles every row', () => {
    expect(FolderIngestionEventSchema.safeParse({ relativePath: 'note.md', outcome: 'imported' }).success).toBe(false);
    expect(reconcileFolderInventory([
      { outcome: 'imported' }, { outcome: 'excluded' }, { outcome: 'changed' }, { outcome: 'failed' },
    ])).toMatchObject({ previewed: 4, imported: 1, excluded: 1, changed: 1, failed: 1, pending: 0 });
  });
});
