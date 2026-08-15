import { describe, expect, it } from 'vitest';
import { CLIENT_IDS, capabilityForClient } from '../../packages/create/src/clients.js';
import { recallClientCapabilities } from '../../src/services/recall-tutorial/recall-tutorial-schemas.js';

describe('recall tutorial client matrix', () => {
  it('stays aligned with installer support and verification modes', () => {
    for (const environment of ['native', 'wsl'] as const) {
      const tutorial = new Map(recallClientCapabilities(environment).map((item) => [item.id, item]));
      for (const id of CLIENT_IDS) {
        const installer = capabilityForClient(id, 'unknown', environment === 'wsl');
        expect(tutorial.get(id)).toMatchObject({
          supported: installer.supported,
          verification: installer.verification,
        });
      }
    }
  });
});
