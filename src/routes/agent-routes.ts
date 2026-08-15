import { Router } from 'express';
import { z } from 'zod';
import type { ContentService } from '../services/content/content-service.js';
import { AskSchema, QuerySchema, RetrieveSchema, SummarizeSchema } from '../services/content/content-service.js';
import type { Principal } from '../types/api.js';
import { requireApiCapability } from '../middleware/api-capability.js';

const SchemaQuery = z.object({ libraryId: z.string().optional(), librarySlug: z.string().optional() });

function principal(req: Express.Request): Principal {
  return { tenantId: req.tenantId as string, apiKeyId: req.apiKeyId as string, libraryId: req.libraryId, surface: req.apiSurface, client: req.apiClient };
}

function envelope<T>(data: T) { return { success: true, data }; }

export function createAgentRoutes(service: ContentService): Router {
  const router = Router();

  router.use(requireApiCapability('read'));

  router.get('/schema', async (req, res, next) => {
    try {
      const query = SchemaQuery.parse(req.query);
      res.json(envelope(await service.schema(principal(req), query.libraryId, query.librarySlug)));
    } catch (error) { next(error); }
  });
  router.post('/query', async (req, res, next) => {
    try { res.json(envelope(await service.query(principal(req), QuerySchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.post('/retrieve', async (req, res, next) => {
    try { res.json(envelope(await service.retrieve(principal(req), RetrieveSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.post('/summarize', async (req, res, next) => {
    try { res.json(envelope(await service.summarize(principal(req), SummarizeSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.post('/ask', async (req, res, next) => {
    try { res.json(envelope(await service.ask(principal(req), AskSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });

  return router;
}
