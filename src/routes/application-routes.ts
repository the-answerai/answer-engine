import { Router } from 'express';
import type { Principal } from '../types/api.js';
import type { ApplicationService } from '../services/application/application-service.js';
import { AccessDeniedError } from '../utils/errors.js';
import {
  AccessTokenCreateSchema,
  AccessTokenUpdateSchema,
  AuditQuerySchema,
  BatchJobCreateSchema,
  BlobUploadSchema,
  DashboardCreateSchema,
  DashboardUpdateSchema,
  LibraryCreateSchema,
  LibraryMembersSchema,
  LibraryPreviewSchema,
  LibraryUpdateSchema,
  LocalSettingsUpdateSchema,
  PageSchema,
  RecipeCreateSchema,
  RecipePreviewSchema,
  RecipeUpdateSchema,
  ReportCreateSchema,
  ReportUpdateSchema,
  TagAssignmentSchema,
  TagCreateSchema,
  TagUpdateSchema,
  UuidSchema,
} from '../services/application/application-schemas.js';

function principal(req: Express.Request): Principal {
  return {
    tenantId: req.tenantId as string,
    apiKeyId: req.apiKeyId as string,
    libraryId: req.libraryId,
  };
}

function envelope<T>(data: T, meta?: Record<string, unknown>) {
  return { success: true, data, ...(meta ? { meta } : {}) };
}

export function createApplicationRoutes(service: ApplicationService): Router {
  const router = Router();

  router.use((req, _res, next) => {
    const isRead = req.method === 'GET'
      || (req.method === 'POST' && req.path.endsWith('/preview'));
    if (!isRead && req.apiCapabilities && !req.apiCapabilities.includes('write')) {
      next(new AccessDeniedError());
      return;
    }
    next();
  });

  router.get('/tags', async (req, res, next) => {
    try { res.json(envelope(await service.listTags(principal(req)))); } catch (error) { next(error); }
  });
  router.post('/tags', async (req, res, next) => {
    try { res.status(201).json(envelope(await service.createTag(principal(req), TagCreateSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.patch('/tags/:id', async (req, res, next) => {
    try { res.json(envelope(await service.updateTag(principal(req), UuidSchema.parse(req.params.id), TagUpdateSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.delete('/tags/:id', async (req, res, next) => {
    try { await service.deleteTag(principal(req), UuidSchema.parse(req.params.id)); res.status(204).end(); }
    catch (error) { next(error); }
  });
  router.post('/tags/:id/content', async (req, res, next) => {
    try { res.json(envelope(await service.assignTag(principal(req), UuidSchema.parse(req.params.id), TagAssignmentSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.delete('/tags/:id/content', async (req, res, next) => {
    try { res.json(envelope(await service.assignTag(principal(req), UuidSchema.parse(req.params.id), TagAssignmentSchema.parse(req.body), true))); }
    catch (error) { next(error); }
  });

  router.get('/libraries', async (req, res, next) => {
    try { res.json(envelope(await service.listLibraries(principal(req)))); } catch (error) { next(error); }
  });
  router.post('/libraries', async (req, res, next) => {
    try { res.status(201).json(envelope(await service.createLibrary(principal(req), LibraryCreateSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.get('/libraries/:libraryId', async (req, res, next) => {
    try { res.json(envelope(await service.getLibrary(principal(req), UuidSchema.parse(req.params.libraryId)))); }
    catch (error) { next(error); }
  });
  router.patch('/libraries/:libraryId', async (req, res, next) => {
    try { res.json(envelope(await service.updateLibrary(principal(req), UuidSchema.parse(req.params.libraryId), LibraryUpdateSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.delete('/libraries/:libraryId', async (req, res, next) => {
    try { await service.deleteLibrary(principal(req), UuidSchema.parse(req.params.libraryId)); res.status(204).end(); }
    catch (error) { next(error); }
  });
  router.get('/libraries/:libraryId/members', async (req, res, next) => {
    try { res.json(envelope(await service.listLibraryMembers(principal(req), UuidSchema.parse(req.params.libraryId), LibraryMembersSchema.parse(req.query)))); }
    catch (error) { next(error); }
  });
  router.post('/libraries/:libraryId/preview', async (req, res, next) => {
    try { res.json(envelope(await service.previewLibrary(principal(req), UuidSchema.parse(req.params.libraryId), LibraryPreviewSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  for (const mode of ['include', 'exclude'] as const) {
    const path = `/libraries/:libraryId/${mode}s/:contentId`;
    router.put(path, async (req, res, next) => {
      try { res.json(envelope(await service.setManualMembership(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.contentId), mode, false))); }
      catch (error) { next(error); }
    });
    router.delete(path, async (req, res, next) => {
      try { res.json(envelope(await service.setManualMembership(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.contentId), mode, true))); }
      catch (error) { next(error); }
    });
  }

  router.get('/libraries/:libraryId/recipes', async (req, res, next) => {
    try { res.json(envelope(await service.listRecipes(principal(req), UuidSchema.parse(req.params.libraryId)))); }
    catch (error) { next(error); }
  });
  router.post('/libraries/:libraryId/recipes', async (req, res, next) => {
    try { res.status(201).json(envelope(await service.createRecipe(principal(req), UuidSchema.parse(req.params.libraryId), RecipeCreateSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.patch('/libraries/:libraryId/recipes/:recipeId', async (req, res, next) => {
    try { res.json(envelope(await service.updateRecipe(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.recipeId), RecipeUpdateSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.delete('/libraries/:libraryId/recipes/:recipeId', async (req, res, next) => {
    try { await service.deleteRecipe(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.recipeId)); res.status(204).end(); }
    catch (error) { next(error); }
  });
  router.post('/libraries/:libraryId/recipes/:recipeId/preview', async (req, res, next) => {
    try { res.json(envelope(await service.previewRecipe(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.recipeId), RecipePreviewSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.post('/libraries/:libraryId/recipes/:recipeId/runs', async (req, res, next) => {
    try { res.status(202).json(envelope(await service.runRecipe(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.recipeId)))); }
    catch (error) { next(error); }
  });
  router.get('/libraries/:libraryId/recipes/:recipeId/runs', async (req, res, next) => {
    try { res.json(envelope(await service.listRecipeRuns(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.recipeId)))); }
    catch (error) { next(error); }
  });
  router.get('/libraries/:libraryId/runs/:runId', async (req, res, next) => {
    try { res.json(envelope(await service.getRecipeRun(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.runId)))); }
    catch (error) { next(error); }
  });
  router.post('/libraries/:libraryId/runs/:runId/cancel', async (req, res, next) => {
    try { res.json(envelope(await service.cancelRecipeRun(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.runId)))); }
    catch (error) { next(error); }
  });
  router.post('/libraries/:libraryId/runs/:runId/retry', async (req, res, next) => {
    try { res.status(202).json(envelope(await service.retryRecipeRun(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.runId)))); }
    catch (error) { next(error); }
  });

  router.get('/content/:contentId/artifacts', async (req, res, next) => {
    try { res.json(envelope(await service.listArtifacts(principal(req), UuidSchema.parse(req.params.contentId)))); }
    catch (error) { next(error); }
  });
  router.get('/artifacts/:artifactId', async (req, res, next) => {
    try { res.json(envelope(await service.getArtifact(principal(req), UuidSchema.parse(req.params.artifactId)))); }
    catch (error) { next(error); }
  });

  router.get('/libraries/:libraryId/reports', async (req, res, next) => {
    try { res.json(envelope(await service.listReports(principal(req), UuidSchema.parse(req.params.libraryId)))); }
    catch (error) { next(error); }
  });
  router.post('/libraries/:libraryId/reports', async (req, res, next) => {
    try { res.status(201).json(envelope(await service.createReport(principal(req), UuidSchema.parse(req.params.libraryId), ReportCreateSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.patch('/libraries/:libraryId/reports/:reportId', async (req, res, next) => {
    try { res.json(envelope(await service.updateReport(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.reportId), ReportUpdateSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.delete('/libraries/:libraryId/reports/:reportId', async (req, res, next) => {
    try { await service.deleteReport(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.reportId)); res.status(204).end(); }
    catch (error) { next(error); }
  });
  router.post('/libraries/:libraryId/reports/:reportId/generate', async (req, res, next) => {
    try { res.status(202).json(envelope(await service.generateReport(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.reportId)))); }
    catch (error) { next(error); }
  });
  router.get('/libraries/:libraryId/reports/:reportId/generated', async (req, res, next) => {
    try { res.json(envelope(await service.listGeneratedReports(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.reportId)))); }
    catch (error) { next(error); }
  });
  router.post('/libraries/:libraryId/reports/:reportId/generated/:generatedId/cancel', async (req, res, next) => {
    try { res.json(envelope(await service.cancelGeneratedReport(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.reportId), UuidSchema.parse(req.params.generatedId)))); }
    catch (error) { next(error); }
  });
  router.post('/libraries/:libraryId/reports/:reportId/generated/:generatedId/retry', async (req, res, next) => {
    try { res.status(202).json(envelope(await service.retryGeneratedReport(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.reportId), UuidSchema.parse(req.params.generatedId)))); }
    catch (error) { next(error); }
  });

  router.get('/libraries/:libraryId/dashboards', async (req, res, next) => {
    try { res.json(envelope(await service.listDashboards(principal(req), UuidSchema.parse(req.params.libraryId)))); }
    catch (error) { next(error); }
  });
  router.post('/libraries/:libraryId/dashboards', async (req, res, next) => {
    try { res.status(201).json(envelope(await service.createDashboard(principal(req), UuidSchema.parse(req.params.libraryId), DashboardCreateSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.patch('/libraries/:libraryId/dashboards/:dashboardId', async (req, res, next) => {
    try { res.json(envelope(await service.updateDashboard(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.dashboardId), DashboardUpdateSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.delete('/libraries/:libraryId/dashboards/:dashboardId', async (req, res, next) => {
    try { await service.deleteDashboard(principal(req), UuidSchema.parse(req.params.libraryId), UuidSchema.parse(req.params.dashboardId)); res.status(204).end(); }
    catch (error) { next(error); }
  });

  router.get('/batch-jobs', async (req, res, next) => {
    try { res.json(envelope(await service.listBatchJobs(principal(req), PageSchema.parse(req.query)))); }
    catch (error) { next(error); }
  });
  router.post('/batch-jobs', async (req, res, next) => {
    try { res.status(202).json(envelope(await service.createBatchJob(principal(req), BatchJobCreateSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.get('/batch-jobs/:jobId', async (req, res, next) => {
    try { res.json(envelope(await service.getBatchJob(principal(req), UuidSchema.parse(req.params.jobId)))); }
    catch (error) { next(error); }
  });
  router.post('/batch-jobs/:jobId/cancel', async (req, res, next) => {
    try { res.json(envelope(await service.cancelBatchJob(principal(req), UuidSchema.parse(req.params.jobId)))); }
    catch (error) { next(error); }
  });
  router.post('/batch-jobs/:jobId/retry', async (req, res, next) => {
    try { res.status(202).json(envelope(await service.retryBatchJob(principal(req), UuidSchema.parse(req.params.jobId)))); }
    catch (error) { next(error); }
  });

  router.get('/access-tokens', async (req, res, next) => {
    try { res.json(envelope(await service.listAccessTokens(principal(req)))); } catch (error) { next(error); }
  });
  router.post('/access-tokens', async (req, res, next) => {
    try { res.status(201).json(envelope(await service.createAccessToken(principal(req), AccessTokenCreateSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.patch('/access-tokens/:tokenId', async (req, res, next) => {
    try { res.json(envelope(await service.updateAccessToken(principal(req), UuidSchema.parse(req.params.tokenId), AccessTokenUpdateSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.delete('/access-tokens/:tokenId', async (req, res, next) => {
    try { res.json(envelope(await service.revokeAccessToken(principal(req), UuidSchema.parse(req.params.tokenId)))); }
    catch (error) { next(error); }
  });

  router.get('/audit', async (req, res, next) => {
    try { res.json(envelope(await service.listAudit(principal(req), AuditQuerySchema.parse(req.query)))); }
    catch (error) { next(error); }
  });

  router.get('/settings', async (req, res, next) => {
    try { res.json(envelope(await service.getSettings(principal(req)))); } catch (error) { next(error); }
  });
  router.patch('/settings', async (req, res, next) => {
    try { res.json(envelope(await service.updateSettings(principal(req), LocalSettingsUpdateSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });

  router.get('/content/:contentId/blobs', async (req, res, next) => {
    try { res.json(envelope(await service.listBlobs(principal(req), UuidSchema.parse(req.params.contentId)))); }
    catch (error) { next(error); }
  });
  router.post('/content/:contentId/blobs', async (req, res, next) => {
    try { res.status(201).json(envelope(await service.uploadBlob(principal(req), UuidSchema.parse(req.params.contentId), BlobUploadSchema.parse(req.body)))); }
    catch (error) { next(error); }
  });
  router.get('/blobs/:blobId/download', async (req, res, next) => {
    try {
      const blob = await service.downloadBlob(principal(req), UuidSchema.parse(req.params.blobId));
      res.setHeader('Content-Type', blob.mediaType);
      const fileName = [...blob.fileName].map((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127 || character === '"' || character === '\\'
          ? '_'
          : character;
      }).join('');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.send(blob.data);
    } catch (error) { next(error); }
  });

  return router;
}
