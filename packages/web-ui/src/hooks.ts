import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  assignTag,
  createLibrary,
  createTag,
  deleteContent,
  deleteLibrary,
  deleteTag,
  getContent,
  getLibrary,
  importContent,
  inspectLineage,
  listArtifacts,
  listBlobs,
  listContent,
  listLibraries,
  listLibraryMembers,
  listTags,
  previewImport,
  previewLibrary,
  setLibraryMembership,
  updateLibrary,
  updateTag,
} from './api';
import type { ContentFilters, ImportItem, LibraryFilter, Tag } from './types';

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
