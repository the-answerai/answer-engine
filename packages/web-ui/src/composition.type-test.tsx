import type { WebAppExtensions } from './composition';

const validExtension = {
  capabilities: [{ id: 'fixture.valid', label: 'Valid fixture', family: 'roles' }],
  authorization: { decide: () => ({ allowed: true }) },
} satisfies WebAppExtensions;

void validExtension;

const invalidExtension = {
  capabilities: [
    // @ts-expect-error Only the paid extension-family allowlist is accepted.
    { id: 'fixture.invalid', label: 'Invalid fixture', family: 'workspaces' },
  ],
} satisfies WebAppExtensions;

void invalidExtension;
