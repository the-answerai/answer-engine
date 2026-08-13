import { describe, expect, it } from 'vitest';
import {
  LibraryFilterSchema,
  buildEffectiveMembership,
} from '../../src/services/library/library-membership.js';

describe('library effective membership', () => {
  it('compiles saved filters with parameterized values and exclude precedence', () => {
    const parameters: unknown[] = ['tenant-id', 'library-id'];
    const filter = LibraryFilterSchema.parse({
      operator: 'and',
      conditions: [
        { field: 'content_type', operator: 'in', value: ['chat', 'document'] },
        { field: 'metadata.project', operator: 'eq', value: 'answer-engine' },
        { field: 'tag', operator: 'in', value: ['local-history'] },
      ],
    });

    const sql = buildEffectiveMembership({
      contentAlias: 'c',
      tenantParameter: 1,
      libraryParameter: 2,
      filter,
      parameters,
    });

    expect(sql).toContain('library_manual_includes');
    expect(sql).toContain('library_manual_excludes');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).not.toContain('answer-engine');
    expect(sql).not.toContain('local-history');
    expect(parameters).toEqual([
      'tenant-id',
      'library-id',
      ['chat', 'document'],
      'project',
      'answer-engine',
      ['local-history'],
    ]);
  });

  it('rejects unknown fields and operators', () => {
    expect(() => LibraryFilterSchema.parse({
      operator: 'and',
      conditions: [{ field: 'owner_id', operator: 'eq', value: 'private' }],
    })).toThrow();
    expect(() => LibraryFilterSchema.parse({
      operator: 'and',
      conditions: [{ field: 'source', operator: 'execute', value: 'local' }],
    })).toThrow();
  });
});
