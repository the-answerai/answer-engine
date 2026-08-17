import { Router } from 'express';
import { z } from 'zod';
import { requireApiCapability } from '../middleware/api-capability.js';
import type { FirstImportService } from '../services/first-import/first-import-service.js';
import {
  FirstImportApprovalSchema,
  FirstImportDiscoverySchema,
  FirstImportEventSchema,
} from '../services/first-import/first-import-schemas.js';
import type { Principal } from '../types/api.js';

const IdSchema = z.string().uuid();

function principal(req: Express.Request): Principal {
  return { tenantId: req.tenantId as string, apiKeyId: req.apiKeyId as string, libraryId: req.libraryId };
}

function envelope<T>(data: T) { return { success: true, data }; }

export function createFirstImportRoutes(service: FirstImportService): Router {
  const router = Router();
  router.use(requireApiCapability((req) => req.method === 'GET' ? 'read' : 'write'));

  router.post('/', async (req, res, next) => {
    try {
      const data = await service.registerDiscovery(principal(req), FirstImportDiscoverySchema.parse(req.body));
      res.status(201).json(envelope(data));
    } catch (error) { next(error); }
  });
  router.get('/latest', async (req, res, next) => {
    try { res.json(envelope(await service.latest(principal(req)))); } catch (error) { next(error); }
  });
  router.get('/:id', async (req, res, next) => {
    try { res.json(envelope(await service.get(principal(req), IdSchema.parse(req.params.id)))); } catch (error) { next(error); }
  });
  router.post('/:id/approve', async (req, res, next) => {
    try {
      res.json(envelope(await service.approve(
        principal(req), IdSchema.parse(req.params.id), FirstImportApprovalSchema.parse(req.body),
      )));
    } catch (error) { next(error); }
  });
  router.post('/:id/start', async (req, res, next) => {
    try { res.json(envelope(await service.start(principal(req), IdSchema.parse(req.params.id)))); } catch (error) { next(error); }
  });
  router.post('/:id/events', async (req, res, next) => {
    try {
      res.json(envelope(await service.recordEvent(
        principal(req), IdSchema.parse(req.params.id), FirstImportEventSchema.parse(req.body),
      )));
    } catch (error) { next(error); }
  });
  router.post('/:id/cancel', async (req, res, next) => {
    try { res.json(envelope(await service.cancel(principal(req), IdSchema.parse(req.params.id)))); } catch (error) { next(error); }
  });
  router.post('/:id/retry', async (req, res, next) => {
    try { res.json(envelope(await service.retry(principal(req), IdSchema.parse(req.params.id)))); } catch (error) { next(error); }
  });
  router.post('/:id/complete', async (req, res, next) => {
    try { res.json(envelope(await service.complete(principal(req), IdSchema.parse(req.params.id)))); } catch (error) { next(error); }
  });
  return router;
}
