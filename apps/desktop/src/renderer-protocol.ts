import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function resolveRendererAsset(root: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  if (url.protocol !== 'answer-engine:' || url.hostname !== 'desktop') {
    throw new Error('Untrusted desktop renderer origin.');
  }
  const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const target = resolve(root, `.${requested}`);
  const prefix = `${resolve(root)}${sep}`;
  if (!target.startsWith(prefix)) throw new Error('Renderer asset path escaped its root.');
  if (!Object.hasOwn(TYPES, extname(target))) throw new Error('Renderer asset type is not allowed.');
  return target;
}

export async function rendererResponse(root: string, requestUrl: string): Promise<Response> {
  try {
    const path = resolveRendererAsset(root, requestUrl);
    return new Response(await readFile(path), {
      status: 200,
      headers: {
        'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
