import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

describe('OpenAPI neutral application boundary', () => {
  it('documents every neutral capability family and no paid-only concepts', async () => {
    const source = await readFile('openapi/answer-engine.yaml', 'utf8');
    const document = YAML.parse(source) as {
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
    };

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
      '/api/v1/first-imports',
      '/api/v1/first-imports/{sessionId}/approve',
      '/api/v1/folder-sources',
      '/api/v1/folder-sources/runs/{runId}/approve',
      '/api/v1/organization-plans',
      '/api/v1/organization-plans/{planId}/apply',
      '/api/v1/organization-plans/{planId}/undo',
    ]));
    expect(source).not.toMatch(/auth0|stripe|rbac|billing|permissions|teams|user roles/i);

    const bodyOperations = [
      ['patch', '/api/v1/tags/{tagId}'],
      ['post', '/api/v1/tags/{tagId}/content'],
      ['patch', '/api/v1/libraries/{libraryId}'],
      ['post', '/api/v1/libraries/{libraryId}/preview'],
      ['patch', '/api/v1/libraries/{libraryId}/recipes/{recipeId}'],
      ['post', '/api/v1/libraries/{libraryId}/recipes/{recipeId}/preview'],
      ['post', '/api/v1/libraries/{libraryId}/reports'],
      ['post', '/api/v1/libraries/{libraryId}/dashboards'],
      ['post', '/api/v1/batch-jobs'],
      ['post', '/api/v1/access-tokens'],
      ['post', '/api/v1/content/{id}/blobs'],
      ['post', '/api/v1/organization-plans'],
      ['post', '/api/v1/organization-plans/{planId}/apply'],
    ] as const;
    for (const [method, path] of bodyOperations) {
      expect(document.paths[path]?.[method]?.requestBody, `${method.toUpperCase()} ${path}`)
        .toBeDefined();
    }
  });
});
