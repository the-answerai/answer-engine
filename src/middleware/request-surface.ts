import type { RequestHandler } from 'express';
import { z } from 'zod';

export const ApiSurfaceSchema = z.enum(['mcp', 'cli', 'cli-sync', 'browser', 'api']);
export const ApiClientSchema = z.enum(['codex', 'chatgpt-desktop', 'claude-code', 'claude-desktop', 'cursor', 'cli']);

export const identifyRequestSurface: RequestHandler = (request, _response, next) => {
  const sameOriginBrowser = request.get('sec-fetch-site')?.toLowerCase() === 'same-origin';
  const header = ApiSurfaceSchema.safeParse(request.get('x-ae-surface'));
  request.apiSurface = sameOriginBrowser
    ? 'browser'
    : header.success
    ? header.data
    : 'api';
  const client = ApiClientSchema.safeParse(request.get('x-ae-client'));
  const compatible = client.success && (
    (request.apiSurface === 'mcp' && client.data !== 'cli')
    || ((request.apiSurface === 'cli' || request.apiSurface === 'cli-sync') && client.data === 'cli')
  );
  request.apiClient = compatible && client.success ? client.data : undefined;
  next();
};
