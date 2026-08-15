import { describe, expect, it } from 'vitest';
import {
  assertFirstImportTransition,
  reconcileFirstImportCounts,
} from '../../src/services/first-import/first-import-schemas.js';

describe('first import state', () => {
  it('does not allow importing to begin before explicit approval', () => {
    expect(() => assertFirstImportTransition('discovered', 'running')).toThrow(
      'Cannot move first import from discovered to running',
    );
    expect(() => assertFirstImportTransition('discovered', 'approved')).not.toThrow();
  });

  it('reconciles every discovered history into exactly one final outcome', () => {
    expect(reconcileFirstImportCounts({ imported: 4, duplicate: 2, failed: 1, skipped: 3 })).toEqual({
      discovered: 10,
      imported: 4,
      duplicate: 2,
      failed: 1,
      skipped: 3,
    });
  });
});
