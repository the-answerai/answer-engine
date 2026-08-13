import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

describe('OpenAPI neutral application boundary', () => {
  it('documents every neutral capability family and no paid-only concepts', async () => {
    const source = await readFile('openapi/answer-engine.yaml', 'utf8');
    const document = YAML.parse(source) as { paths: Record<string, unknown> };

    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining([
      '/api/v1/tags',
      '/api/v1/libraries',
      '/api/v1/libraries/{libraryId}/recipes',
      '/api/v1/content/{id}/artifacts',
      '/api/v1/libraries/{libraryId}/reports',
      '/api/v1/libraries/{libraryId}/dashboards',
      '/api/v1/batch-jobs',
      '/api/v1/access-tokens',
      '/api/v1/audit',
      '/api/v1/content/{id}/blobs',
    ]));
    expect(source).not.toMatch(/auth0|stripe|rbac|billing|permissions|teams|user roles/i);
  });
});
