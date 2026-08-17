import { describe, expect, it } from 'vitest';
import { resolveRendererAsset } from '../renderer-protocol.js';
import {
  isTrustedDesktopUrl,
  localWebUrl,
  secureWebPreferences,
  shouldQuitAfterLastWindowClosed,
} from '../security.js';

describe('desktop renderer security', () => {
  it('enforces sandboxed isolated renderer preferences', () => {
    expect(secureWebPreferences('/safe/preload.cjs')).toMatchObject({
      preload: '/safe/preload.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
    });
  });

  it('accepts only the local application origin', () => {
    expect(isTrustedDesktopUrl('answer-engine://desktop/index.html')).toBe(true);
    expect(isTrustedDesktopUrl('https://desktop/index.html')).toBe(false);
    expect(isTrustedDesktopUrl('answer-engine://attacker/index.html')).toBe(false);
    expect(isTrustedDesktopUrl('not a url')).toBe(false);
  });

  it('keeps the runtime alive when every window closes', () => {
    expect(shouldQuitAfterLastWindowClosed()).toBe(false);
  });

  it('opens only the selected local web runtime', () => {
    expect(localWebUrl('http://localhost:5050/private?nope=true', 'stable')).toBe('http://localhost:5050/');
    expect(localWebUrl('http://127.0.0.1:5150', 'staging')).toBe('http://127.0.0.1:5150/');
    expect(localWebUrl('http://localhost:5050/private', 'stable', { standaloneWebDevelopment: true }))
      .toBe('http://localhost:3200/');
    expect(localWebUrl('http://127.0.0.1:5150/private', 'staging', { standaloneWebDevelopment: true }))
      .toBe('http://127.0.0.1:3300/');
    expect(() => localWebUrl('https://example.com', 'stable')).toThrow(/non-local/);
  });

  it('prevents renderer path traversal and unknown asset types', () => {
    expect(resolveRendererAsset('/app/renderer', 'answer-engine://desktop/styles.css'))
      .toBe('/app/renderer/styles.css');
    expect(() => resolveRendererAsset('/app/renderer', 'answer-engine://desktop/%2e%2e%2fsecret.txt'))
      .toThrow(/escaped|not allowed/);
    expect(() => resolveRendererAsset('/app/renderer', 'answer-engine://desktop/secrets.json'))
      .toThrow(/not allowed/);
  });
});
