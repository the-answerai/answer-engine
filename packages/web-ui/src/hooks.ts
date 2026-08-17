import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  assignTag,
  cancelBatchJob,
  cancelGeneratedReport,
  cancelRecipeRun,
  createAccessToken,
  createBatchJob,
  createDashboard,
  createLibrary,
  createOrganizationProposal,
  createRecallTutorial,
  createRecipe,
  createReport,
  createTag,
  deleteContent,
  deleteLibrary,
  deleteDashboard,
  deleteRecipe,
  deleteReport,
  deleteTag,
  getContent,
  getBatchJob,
  getLibrary,
  getRecipeRun,
  getSettings,
  importContent,
  latestFirstImport,
  approveFirstImport,
  cancelFirstImport,
  retryFirstImport,
  latestFolderSource,
  approveFolderRun,
  cancelFolderRun,
  retryFolderRun,
  prepareFolderRemoval,
  inspectLineage,
  listArtifacts,
  listAccessTokens,
  listAudit,
  listBatchJobs,
  listBlobs,
  listContent,
  listLibraries,
  listOrganizationPlans,
  listRecallTutorials,
  recallTutorialCapabilities,
  listDashboards,
  listLibraryMembers,
  listGeneratedReports,
  listRecipeRuns,
  listRecipes,
  listReports,
  listTags,
  previewImport,
  previewLibrary,
  previewRecipe,
  retryBatchJob,
  retryGeneratedReport,
  retryRecipeRun,
  revokeAccessToken,
  runRecipe,
  generateReport,
  setLibraryMembership,
  updateLibrary,
  updateDashboard,
  updateRecipe,
  updateReport,
  updateSettings,
  updateAccessToken,
  updateTag,
  applyOrganizationPlan,
  undoOrganizationPlan,
  checkRecallTutorial,
} from './api';
import type { BatchJob, ContentFilters, Dashboard, FirstImportSourceId, ImportItem, LibraryFilter, LocalSettings, OrganizationDecision, RecallTutorialClient, RecipeInput, ReportInput, Tag } from './types';

const isActive = (status?: string) => status === 'queued' || status === 'running';

export function useContent(filters: ContentFilters) {
  return useQuery({ queryKey: ['content', filters], queryFn: () => listContent(filters) });
}

export function useContentDetail(contentId: string | null) {
  return useQuery({
    queryKey: ['content', 'detail', contentId],
    queryFn: () => getContent(contentId as string),
    enabled: Boolean(contentId),
  });
}

export function useContentLineage(contentId: string | null) {
  return useQuery({
    queryKey: ['content', 'lineage', contentId],
    queryFn: () => inspectLineage(contentId as string),
    enabled: Boolean(contentId),
  });
}

export function useContentArtifacts(contentId: string | null) {
  return useQuery({
    queryKey: ['content', 'artifacts', contentId],
    queryFn: () => listArtifacts(contentId as string),
    enabled: Boolean(contentId),
  });
}

export function useContentBlobs(contentId: string | null) {
  return useQuery({
    queryKey: ['content', 'blobs', contentId],
    queryFn: () => listBlobs(contentId as string),
    enabled: Boolean(contentId),
  });
}

function useInvalidatingMutation<TInput, TOutput>(
  mutationFn: (input: TInput) => Promise<TOutput>,
  keys: string[][],
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
    },
  });
}

export function useDeleteContent() {
  return useInvalidatingMutation(deleteContent, [['content'], ['libraries']]);
}

export function useTags() {
  return useQuery({ queryKey: ['tags'], queryFn: listTags });
}

export function useCreateTag() {
  return useInvalidatingMutation(createTag, [['tags']]);
}

export function useUpdateTag() {
  return useInvalidatingMutation(
    ({ id, input }: { id: string; input: Partial<Tag> }) => updateTag(id, input),
    [['tags'], ['content']],
  );
}

export function useDeleteTag() {
  return useInvalidatingMutation(deleteTag, [['tags'], ['content'], ['libraries']]);
}

export function useAssignTag() {
  return useInvalidatingMutation(
    (input: { tagId: string; contentIds: string[]; assigned: boolean }) =>
      assignTag(input.tagId, input.contentIds, input.assigned),
    [['tags'], ['content'], ['libraries']],
  );
}

export function useLibraries() {
  return useQuery({ queryKey: ['libraries'], queryFn: listLibraries });
}

export function useLibrary(libraryId: string | undefined) {
  return useQuery({
    queryKey: ['libraries', 'detail', libraryId],
    queryFn: () => getLibrary(libraryId as string),
    enabled: Boolean(libraryId),
  });
}

export function useCreateLibrary() {
  return useInvalidatingMutation(createLibrary, [['libraries']]);
}

export function useUpdateLibrary() {
  return useInvalidatingMutation(
    ({ id, input }: { id: string; input: Parameters<typeof updateLibrary>[1] }) => updateLibrary(id, input),
    [['libraries'], ['content']],
  );
}

export function useDeleteLibrary() {
  return useInvalidatingMutation(deleteLibrary, [['libraries']]);
}

export function useLibraryMembers(libraryId: string | undefined, query = '', cursor?: string) {
  return useQuery({
    queryKey: ['libraries', libraryId, 'members', query, cursor],
    queryFn: () => listLibraryMembers(libraryId as string, { query: query || undefined, cursor, limit: 25 }),
    enabled: Boolean(libraryId),
  });
}

export function usePreviewLibrary() {
  return useMutation({
    mutationFn: ({ id, filter }: { id: string; filter: LibraryFilter | null }) => previewLibrary(id, filter),
  });
}

export function useSetLibraryMembership() {
  return useInvalidatingMutation(
    (input: { libraryId: string; contentId: string; mode: 'include' | 'exclude'; active: boolean }) =>
      setLibraryMembership(input.libraryId, input.contentId, input.mode, input.active),
    [['libraries'], ['content']],
  );
}

export function useOrganizationPlans() {
  return useQuery({ queryKey: ['organization-plans'], queryFn: listOrganizationPlans });
}

export function useCreateOrganizationProposal() {
  return useInvalidatingMutation(
    createOrganizationProposal,
    [['organization-plans']],
  );
}

export function useApplyOrganizationPlan() {
  return useInvalidatingMutation(
    ({ planId, decisions }: { planId: string; decisions: OrganizationDecision[] }) =>
      applyOrganizationPlan(planId, decisions),
    [['organization-plans'], ['tags'], ['libraries'], ['content']],
  );
}

export function useUndoOrganizationPlan() {
  return useInvalidatingMutation(
    (planId: string) => undoOrganizationPlan(planId),
    [['organization-plans'], ['tags'], ['libraries'], ['content']],
  );
}

export function useRecallTutorialCapabilities(environment: 'native' | 'wsl') {
  return useQuery({ queryKey: ['recall-tutorial-capabilities', environment], queryFn: () => recallTutorialCapabilities(environment) });
}
export function useRecallTutorials() { return useQuery({ queryKey: ['recall-tutorials'], queryFn: listRecallTutorials }); }
export function useCreateRecallTutorial() {
  return useInvalidatingMutation(createRecallTutorial, [['recall-tutorials']]);
}
export function useCheckRecallTutorial() {
  return useInvalidatingMutation(
    ({ id, reportedFailure }: { id: string; reportedFailure?: 'runtime' | 'wiring' | 'access' | 'indexing' | 'retrieval' }) => checkRecallTutorial(id, reportedFailure),
    [['recall-tutorials'], ['audit'], ['content']],
  );
}

export function usePreviewImport() {
  return useMutation({
    mutationFn: ({ items, libraryId }: { items: ImportItem[]; libraryId?: string }) => previewImport(items, libraryId),
  });
}

export function useImportContent() {
  return useInvalidatingMutation(
    ({ items, libraryId }: { items: ImportItem[]; libraryId?: string }) => importContent(items, libraryId),
    [['content'], ['libraries']],
  );
}

export function useLatestFirstImport() {
  return useQuery({
    queryKey: ['first-import'],
    queryFn: latestFirstImport,
    refetchInterval: (query) => ['approved', 'running', 'cancel_requested'].includes(query.state.data?.status ?? '') ? 1_000 : false,
  });
}

export function useApproveFirstImport() {
  return useInvalidatingMutation(
    ({ sessionId, sourceIds }: { sessionId: string; sourceIds: FirstImportSourceId[] }) => approveFirstImport(sessionId, sourceIds),
    [['first-import']],
  );
}

export function useCancelFirstImport() {
  return useInvalidatingMutation(cancelFirstImport, [['first-import']]);
}

export function useRetryFirstImport() {
  return useInvalidatingMutation(retryFirstImport, [['first-import']]);
}

export function useLatestFolderSource() {
  return useQuery({ queryKey: ['folder-source'], queryFn: latestFolderSource,
    refetchInterval: (query) => ['approved', 'running', 'cancel_requested'].includes(query.state.data?.latestRun?.status ?? '') ? 1_000 : false });
}
export function useApproveFolderRun() {
  return useInvalidatingMutation(approveFolderRun, [['folder-source']]);
}
export function useCancelFolderRun() {
  return useInvalidatingMutation(cancelFolderRun, [['folder-source']]);
}
export function useRetryFolderRun() {
  return useInvalidatingMutation(retryFolderRun, [['folder-source']]);
}
export function usePrepareFolderRemoval() {
  return useInvalidatingMutation(
    ({ sourceId, retention }: { sourceId: string; retention: 'keep' | 'delete' }) => prepareFolderRemoval(sourceId, retention),
    [['folder-source']],
  );
}

export function useRecipes(libraryId: string) {
  return useQuery({ queryKey: ['libraries', libraryId, 'recipes'], queryFn: () => listRecipes(libraryId), enabled: Boolean(libraryId) });
}
export function useCreateRecipe(libraryId: string) { return useInvalidatingMutation((input: RecipeInput) => createRecipe(libraryId, input), [['libraries', libraryId, 'recipes']]); }
export function useUpdateRecipe(libraryId: string) { return useInvalidatingMutation(({ id, input }: { id: string; input: Partial<RecipeInput> }) => updateRecipe(libraryId, id, input), [['libraries', libraryId, 'recipes']]); }
export function useDeleteRecipe(libraryId: string) { return useInvalidatingMutation((id: string) => deleteRecipe(libraryId, id), [['libraries', libraryId, 'recipes']]); }
export function usePreviewRecipe(libraryId: string) { return useMutation({ mutationFn: ({ id, contentIds }: { id: string; contentIds?: string[] }) => previewRecipe(libraryId, id, { contentIds, limit: 3 }) }); }
export function useRunRecipe(libraryId: string) { return useInvalidatingMutation((id: string) => runRecipe(libraryId, id), [['libraries', libraryId, 'recipe-runs']]); }
export function useRecipeRuns(libraryId: string, recipeId?: string) {
  return useQuery({
    queryKey: ['libraries', libraryId, 'recipe-runs', recipeId],
    queryFn: () => listRecipeRuns(libraryId, recipeId as string),
    enabled: Boolean(recipeId),
    refetchInterval: (query) => query.state.data?.some((run) => isActive(run.status)) ? 1_500 : false,
  });
}
export function useRecipeRun(libraryId: string, runId?: string) {
  return useQuery({ queryKey: ['libraries', libraryId, 'recipe-run', runId], queryFn: () => getRecipeRun(libraryId, runId as string), enabled: Boolean(runId), refetchInterval: (query) => isActive(query.state.data?.status) ? 1_500 : false });
}
export function useCancelRecipeRun(libraryId: string) { return useInvalidatingMutation((id: string) => cancelRecipeRun(libraryId, id), [['libraries', libraryId, 'recipe-runs'], ['libraries', libraryId, 'recipe-run']]); }
export function useRetryRecipeRun(libraryId: string) { return useInvalidatingMutation((id: string) => retryRecipeRun(libraryId, id), [['libraries', libraryId, 'recipe-runs'], ['libraries', libraryId, 'recipe-run']]); }

export function useReports(libraryId: string) { return useQuery({ queryKey: ['libraries', libraryId, 'reports'], queryFn: () => listReports(libraryId), enabled: Boolean(libraryId) }); }
export function useCreateReport(libraryId: string) { return useInvalidatingMutation((input: ReportInput) => createReport(libraryId, input), [['libraries', libraryId, 'reports']]); }
export function useUpdateReport(libraryId: string) { return useInvalidatingMutation(({ id, input }: { id: string; input: Partial<ReportInput> }) => updateReport(libraryId, id, input), [['libraries', libraryId, 'reports']]); }
export function useDeleteReport(libraryId: string) { return useInvalidatingMutation((id: string) => deleteReport(libraryId, id), [['libraries', libraryId, 'reports']]); }
export function useGenerateReport(libraryId: string) { return useInvalidatingMutation((id: string) => generateReport(libraryId, id), [['libraries', libraryId, 'generated-reports']]); }
export function useGeneratedReports(libraryId: string, reportId?: string) {
  return useQuery({ queryKey: ['libraries', libraryId, 'generated-reports', reportId], queryFn: () => listGeneratedReports(libraryId, reportId as string), enabled: Boolean(reportId), refetchInterval: (query) => query.state.data?.some((report) => isActive(report.status)) ? 1_500 : false });
}
export function useCancelGeneratedReport(libraryId: string, reportId: string) { return useInvalidatingMutation((id: string) => cancelGeneratedReport(libraryId, reportId, id), [['libraries', libraryId, 'generated-reports']]); }
export function useRetryGeneratedReport(libraryId: string, reportId: string) { return useInvalidatingMutation((id: string) => retryGeneratedReport(libraryId, reportId, id), [['libraries', libraryId, 'generated-reports']]); }

export function useDashboards(libraryId: string) { return useQuery({ queryKey: ['libraries', libraryId, 'dashboards'], queryFn: () => listDashboards(libraryId), enabled: Boolean(libraryId) }); }
export function useCreateDashboard(libraryId: string) { return useInvalidatingMutation((input: Parameters<typeof createDashboard>[1]) => createDashboard(libraryId, input), [['libraries', libraryId, 'dashboards']]); }
export function useUpdateDashboard(libraryId: string) { return useInvalidatingMutation(({ id, input }: { id: string; input: Partial<Pick<Dashboard, 'name' | 'description' | 'layout' | 'widgets'>> }) => updateDashboard(libraryId, id, input), [['libraries', libraryId, 'dashboards']]); }
export function useDeleteDashboard(libraryId: string) { return useInvalidatingMutation((id: string) => deleteDashboard(libraryId, id), [['libraries', libraryId, 'dashboards']]); }

export function useBatchJobs(cursor?: string) { return useQuery({ queryKey: ['batch-jobs', cursor], queryFn: () => listBatchJobs({ cursor, limit: 25 }), refetchInterval: (query) => query.state.data?.items.some((job) => isActive(job.status)) ? 1_500 : false }); }
export function useBatchJob(jobId?: string) { return useQuery({ queryKey: ['batch-jobs', 'detail', jobId], queryFn: () => getBatchJob(jobId as string), enabled: Boolean(jobId), refetchInterval: (query) => isActive(query.state.data?.status) ? 1_500 : false }); }
export function useCreateBatchJob() { return useInvalidatingMutation((input: { libraryId?: string | null; kind: BatchJob['kind']; name: string; input: Record<string, unknown>; contentIds?: string[] }) => createBatchJob(input), [['batch-jobs']]); }
export function useCancelBatchJob() { return useInvalidatingMutation(cancelBatchJob, [['batch-jobs']]); }
export function useRetryBatchJob() { return useInvalidatingMutation(retryBatchJob, [['batch-jobs']]); }

export function useAccessTokens() { return useQuery({ queryKey: ['access-tokens'], queryFn: listAccessTokens }); }
export function useCreateAccessToken() { return useInvalidatingMutation(createAccessToken, [['access-tokens'], ['audit']]); }
export function useUpdateAccessToken() { return useInvalidatingMutation(({ id, input }: { id: string; input: Parameters<typeof updateAccessToken>[1] }) => updateAccessToken(id, input), [['access-tokens'], ['audit']]); }
export function useRevokeAccessToken() { return useInvalidatingMutation(revokeAccessToken, [['access-tokens'], ['audit']]); }

export function useAudit(input: { libraryId?: string; action?: string; resourceType?: string; cursor?: string }) { return useQuery({ queryKey: ['audit', input], queryFn: () => listAudit({ ...input, limit: 25 }) }); }
export function useSettings() { return useQuery({ queryKey: ['settings'], queryFn: getSettings }); }
export function useUpdateSettings() { return useInvalidatingMutation((input: Partial<LocalSettings>) => updateSettings(input), [['settings']]); }
