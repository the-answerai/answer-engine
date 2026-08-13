import type { Request, RequestHandler } from 'express';
import { AccessDeniedError } from '../utils/errors.js';

export type ApiCapability = 'read' | 'write';

export function requireApiCapability(
  resolveCapability: ApiCapability | ((request: Request) => ApiCapability),
): RequestHandler {
  return (req, _res, next) => {
    const capability = typeof resolveCapability === 'function'
      ? resolveCapability(req)
      : resolveCapability;
    if (req.apiCapabilities && !req.apiCapabilities.includes(capability)) {
      next(new AccessDeniedError(`This access token does not have ${capability} capability`));
      return;
    }
    next();
  };
}
