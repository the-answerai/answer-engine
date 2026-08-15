import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('installer-owned MCP runtime', () => {
  it('builds and copies the MCP server into the runtime container', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');

    expect(dockerfile).toContain('pnpm --filter @answer-engine/mcp-server build');
    expect(dockerfile).toContain(
      'COPY --from=build /app/packages/mcp-server/dist ./packages/mcp-server/dist',
    );
  });
});
