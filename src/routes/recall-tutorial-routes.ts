import { Router } from 'express';
import { z } from 'zod';
import { requireApiCapability } from '../middleware/api-capability.js';
import type { RecallTutorialService } from '../services/recall-tutorial/recall-tutorial-service.js';
import { RecallTutorialCheckSchema, RecallTutorialCreateSchema } from '../services/recall-tutorial/recall-tutorial-schemas.js';
import type { Principal } from '../types/api.js';

const IdSchema = z.string().uuid();
const EnvironmentSchema = z.object({ environment: z.enum(['native', 'wsl']).default('native') }).strict();

function principal(request: Express.Request): Principal {
  return {
    tenantId: request.tenantId as string,
    apiKeyId: request.apiKeyId as string,
    libraryId: request.libraryId,
    surface: request.apiSurface,
    client: request.apiClient,
  };
}

const envelope = <T>(data: T) => ({ success: true, data });

export function createRecallTutorialRoutes(service: RecallTutorialService): Router {
  const router = Router();
  router.use(requireApiCapability((request) => request.method === 'GET' ? 'read' : 'write'));
  router.get('/capabilities', (request, response, next) => {
    try { response.json(envelope(service.capabilities(EnvironmentSchema.parse(request.query).environment))); }
    catch (error) { next(error); }
  });
  router.get('/', async (request, response, next) => {
    try { response.json(envelope(await service.list(principal(request)))); }
    catch (error) { next(error); }
  });
  router.post('/', async (request, response, next) => {
    try { response.status(201).json(envelope(await service.create(principal(request), RecallTutorialCreateSchema.parse(request.body)))); }
    catch (error) { next(error); }
  });
  router.get('/:id', async (request, response, next) => {
    try { response.json(envelope(await service.get(principal(request), IdSchema.parse(request.params.id)))); }
    catch (error) { next(error); }
  });
  router.post('/:id/check', async (request, response, next) => {
    try { response.json(envelope(await service.check(principal(request), IdSchema.parse(request.params.id), RecallTutorialCheckSchema.parse(request.body)))); }
    catch (error) { next(error); }
  });
  return router;
}
