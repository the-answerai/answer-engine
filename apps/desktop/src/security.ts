import type { WebPreferences } from 'electron';

export const DESKTOP_ORIGIN = 'answer-engine://desktop';

export function secureWebPreferences(preload: string, fixture = false): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: false,
    devTools: fixture,
  };
}

export function isTrustedDesktopUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'answer-engine:' && url.hostname === 'desktop';
  } catch {
    return false;
  }
}

export function localWebUrl(apiUrl: string, channel: 'stable' | 'staging'): string {
  const url = new URL(apiUrl);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('Refusing to open a non-local runtime URL.');
  }
  url.port = channel === 'stable' ? '3200' : '3300';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function shouldQuitAfterLastWindowClosed(): boolean {
  return false;
}
