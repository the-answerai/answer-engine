import { Router } from 'express';
import { z } from 'zod';
import type { ContentService } from '../services/content/content-service.js';
import { ContentListSchema, ImportRequestSchema } from '../services/content/content-service.js';
import type { Principal } from '../types/api.js';
import { requireApiCapability } from '../middleware/api-capability.js';

const IdSchema = z.string().uuid();

function principal(req: Express.Request): Principal {
  return { tenantId: req.tenantId as string, apiKeyId: req.apiKeyId as string, libraryId: req.libraryId };
}

function envelope<T>(data: T, meta?: Record<string, unknown>) {
  return { success: true, data, ...(meta ? { meta } : {}) };
}

export function createContentRoutes(service: ContentService): Router {
  const router = Router();

  router.use(requireApiCapability((req) => {
    const isRead = req.method === 'GET' || req.path === '/import/preview';
    return isRead ? 'read' : 'write';
  }));

  router.post('/import/preview', (req, res, next) => {
    try {
      const input = ImportRequestSchema.parse(req.body);
      res.json(envelope({
        format: 'json', rowCount: input.items.length, sample: input.items.slice(0, 5), parseErrors: [],
        requiresApproval: false, requiresIdForIdempotency: false,
      }));
    } catch (error) { next(error); }
  });

  router.post('/import', async (req, res, next) => {
    try {
      const input = ImportRequestSchema.parse(req.body);
      const data = await service.importContent(principal(req), input);
      res.status(201).json(envelope(data));
    } catch (error) { next(error); }
  });

  router.get('/', async (req, res, next) => {
    try {
      const input = ContentListSchema.parse(req.query);
      const result = await service.list(principal(req), input);
      res.json(envelope(result.items, { ...result.meta, ...(result.scope ? { scope: result.scope } : {}) }));
    } catch (error) { next(error); }
  });

  router.get('/:id/lineage', async (req, res, next) => {
    try { res.json(envelope(await service.lineage(principal(req), IdSchema.parse(req.params.id)))); }
    catch (error) { next(error); }
  });

  router.get('/:id', async (req, res, next) => {
    try { res.json(envelope(await service.get(principal(req), IdSchema.parse(req.params.id)))); }
    catch (error) { next(error); }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      await service.remove(principal(req), IdSchema.parse(req.params.id));
      res.status(204).end();
    } catch (error) { next(error); }
  });

  return router;
}
