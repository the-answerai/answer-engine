import { Router } from 'express';
import { z } from 'zod';
import { requireApiCapability } from '../middleware/api-capability.js';
import type { FolderIngestionService } from '../services/folder-ingestion/folder-ingestion-service.js';
import {
  FolderIngestionEventSchema,
  FolderRefreshDiscoverySchema,
  FolderRemovalCompleteSchema,
  FolderRemovalSchema,
  FolderSourceDiscoverySchema,
} from '../services/folder-ingestion/folder-ingestion-schemas.js';
import type { Principal } from '../types/api.js';

const IdSchema = z.string().uuid();
function principal(req: Express.Request): Principal {
  return { tenantId: req.tenantId as string, apiKeyId: req.apiKeyId as string, libraryId: req.libraryId };
}
function envelope<T>(data: T) { return { success: true, data }; }

export function createFolderIngestionRoutes(service: FolderIngestionService): Router {
  const router = Router();
  router.use(requireApiCapability((req) => req.method === 'GET' ? 'read' : 'write'));
  router.post('/', async (req, res, next) => {
    try { res.status(201).json(envelope(await service.register(principal(req), FolderSourceDiscoverySchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.get('/', async (req, res, next) => {
    try { res.json(envelope(await service.list(principal(req)))); } catch (error) { next(error); }
  });
  router.get('/latest', async (req, res, next) => {
    try { res.json(envelope(await service.latest(principal(req)))); } catch (error) { next(error); }
  });
  router.get('/:sourceId', async (req, res, next) => {
    try { res.json(envelope(await service.get(principal(req), IdSchema.parse(req.params.sourceId)))); }
    catch (error) { next(error); }
  });
  router.post('/:sourceId/refresh', async (req, res, next) => {
    try { res.status(201).json(envelope(await service.refresh(principal(req), IdSchema.parse(req.params.sourceId), FolderRefreshDiscoverySchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.post('/:sourceId/remove', async (req, res, next) => {
    try { res.json(envelope(await service.prepareRemoval(principal(req), IdSchema.parse(req.params.sourceId), FolderRemovalSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.post('/:sourceId/remove/complete', async (req, res, next) => {
    try { res.json(envelope(await service.completeRemoval(principal(req), IdSchema.parse(req.params.sourceId), FolderRemovalCompleteSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.post('/runs/:runId/approve', async (req, res, next) => {
    try { res.json(envelope(await service.approve(principal(req), IdSchema.parse(req.params.runId)))); }
    catch (error) { next(error); }
  });
  router.post('/runs/:runId/start', async (req, res, next) => {
    try { res.json(envelope(await service.start(principal(req), IdSchema.parse(req.params.runId)))); }
    catch (error) { next(error); }
  });
  router.post('/runs/:runId/events', async (req, res, next) => {
    try { res.json(envelope(await service.recordEvent(principal(req), IdSchema.parse(req.params.runId), FolderIngestionEventSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.post('/runs/:runId/cancel', async (req, res, next) => {
    try { res.json(envelope(await service.cancel(principal(req), IdSchema.parse(req.params.runId)))); }
    catch (error) { next(error); }
  });
  router.post('/runs/:runId/retry', async (req, res, next) => {
    try { res.json(envelope(await service.retry(principal(req), IdSchema.parse(req.params.runId)))); }
    catch (error) { next(error); }
  });
  router.post('/runs/:runId/complete', async (req, res, next) => {
    try { res.json(envelope(await service.complete(principal(req), IdSchema.parse(req.params.runId)))); }
    catch (error) { next(error); }
  });
  return router;
}
