import { Router } from 'express';
import { z } from 'zod';
import { requireApiCapability } from '../middleware/api-capability.js';
import type { OrganizationService } from '../services/organization/organization-service.js';
import {
  OrganizationApplyRequestSchema,
  OrganizationProposalRequestSchema,
} from '../services/organization/organization-schemas.js';
import type { Principal } from '../types/api.js';

const UuidSchema = z.string().uuid();

function principal(req: Express.Request): Principal {
  return {
    tenantId: req.tenantId as string,
    apiKeyId: req.apiKeyId as string,
    libraryId: req.libraryId,
  };
}

function envelope<T>(data: T) {
  return { success: true, data };
}

export function createOrganizationRoutes(service: OrganizationService): Router {
  const router = Router();
  router.use(requireApiCapability((req) => req.method === 'GET' ? 'read' : 'write'));

  router.post('/', async (req, res, next) => {
    try {
      const plan = await service.createProposal(
        principal(req),
        OrganizationProposalRequestSchema.parse(req.body),
      );
      res.status(201).json(envelope(plan));
    } catch (error) { next(error); }
  });
  router.get('/', async (req, res, next) => {
    try { res.json(envelope(await service.listPlans(principal(req)))); }
    catch (error) { next(error); }
  });
  router.get('/:planId', async (req, res, next) => {
    try { res.json(envelope(await service.getPlan(principal(req), UuidSchema.parse(req.params.planId)))); }
    catch (error) { next(error); }
  });
  router.post('/:planId/apply', async (req, res, next) => {
    try {
      res.json(envelope(await service.applyPlan(
        principal(req),
        UuidSchema.parse(req.params.planId),
        OrganizationApplyRequestSchema.parse(req.body),
      )));
    } catch (error) { next(error); }
  });
  router.post('/:planId/undo', async (req, res, next) => {
    try { res.json(envelope(await service.undoPlan(principal(req), UuidSchema.parse(req.params.planId)))); }
    catch (error) { next(error); }
  });
  return router;
}
