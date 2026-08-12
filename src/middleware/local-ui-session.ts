import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

export const LOCAL_UI_SESSION_COOKIE = 'answer_engine_local_ui';

const SESSION_PURPOSE = 'answer-engine-local-ui-session-v1';

function sessionToken(apiKey: string): Buffer {
  return createHmac('sha256', apiKey).update(SESSION_PURPOSE).digest();
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [cookieName, ...valueParts] = part.trim().split('=');
    if (cookieName !== name) continue;
    const value = valueParts.join('=');
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function hasValidLocalUiSession(request: Request, apiKey: string): boolean {
  if (request.get('sec-fetch-site')?.toLowerCase() !== 'same-origin') return false;
  const value = cookieValue(request, LOCAL_UI_SESSION_COOKIE);
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) return false;
  const actual = Buffer.from(value, 'hex');
  const expected = sessionToken(apiKey);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createLocalUiSessionCookie(apiKey: string): RequestHandler {
  const token = sessionToken(apiKey).toString('hex');
  return (request, response, next) => {
    if (request.get('sec-fetch-site')?.toLowerCase() !== 'same-origin') {
      response.status(403).json({ error: { code: 'FORBIDDEN', message: 'Same-origin browser request required' } });
      return;
    }
    response.cookie(LOCAL_UI_SESSION_COOKIE, token, {
      httpOnly: true,
      path: '/api/v1',
      sameSite: 'strict',
      secure: request.secure,
    });
    next();
  };
}
