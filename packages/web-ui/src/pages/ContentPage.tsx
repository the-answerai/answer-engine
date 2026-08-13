import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { downloadTextFile } from '../api';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  LoadingState,
  Notice,
  PageHeader,
  TagChip,
  errorMessage,
  formatDate,
} from '../components';
import {
  useAssignTag,
  useContent,
  useContentArtifacts,
  useContentBlobs,
  useContentDetail,
  useContentLineage,
  useDeleteContent,
  useLibraries,
  useSetLibraryMembership,
  useSettings,
  useTags,
} from '../hooks';
import type { Artifact, ContentFilters, ContentItem, ContentSort, ContentType } from '../types';
import { CONTENT_TYPES } from '../types';
import { SelectedContentBatchButton } from './BatchJobsPage';

const PAGE_SIZE = 25;

export function ContentPage() {
  const [filters, setFilters] = useState<ContentFilters>({ limit: PAGE_SIZE, sortBy: 'createdAt', sortDirection: 'desc' });
  const [searchInput, setSearchInput] = useState('');
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([undefined]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const tags = useTags();
  const libraries = useLibraries();
  const settings = useSettings();
  const defaultsApplied = useRef(false);
  const query = useContent({ ...filters, cursor: cursorHistory[cursorHistory.length - 1] });
  const items = query.data?.items ?? [];
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  useEffect(() => {
    if (defaultsApplied.current || !settings.data || !libraries.data
      || typeof settings.data.defaultPageSize !== 'number') return;
    defaultsApplied.current = true;
    const defaultLibraryId = libraries.data.some(
      (library) => library.id === settings.data?.defaultLibraryId,
    ) ? settings.data.defaultLibraryId : null;
    setFilters((current) => ({
      ...current,
      limit: settings.data.defaultPageSize,
      libraryId: defaultLibraryId ?? undefined,
    }));
  }, [libraries.data, settings.data]);

  function search(event: FormEvent) {
    event.preventDefault();
    setCursorHistory([undefined]);
    setSelected(new Set());
    setFilters((current) => ({ ...current, search: searchInput.trim() || undefined }));
  }
  function updateFilter<Key extends keyof ContentFilters>(key: Key, value: ContentFilters[Key]) {
    setCursorHistory([undefined]);
    setSelected(new Set());
    setFilters((current) => ({ ...current, [key]: value || undefined }));
  }
  function updateDateFilter(key: 'dateFrom' | 'dateTo', value: string) {
    const time = key === 'dateFrom' ? 'T00:00:00.000Z' : 'T23:59:59.999Z';
    updateFilter(key, value ? `${value}${time}` : undefined);
  }
  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <section className="workspace-page">
      <PageHeader eyebrow="FIG. 01 / MEMORY INDEX" title="Content" description="Search, organize, and inspect the evidence preserved in your local memory." actions={<Button variant="secondary" onClick={() => void query.refetch()}>Refresh</Button>} />
      <div className="filter-panel">
        <form className="search-form" onSubmit={search}>
          <Field label="Search"><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search titles, summaries, and transcripts…" /></Field>
          <Button type="submit">Search</Button>
        </form>
        <div className="filter-row">
          <Field label="Library"><select value={filters.libraryId ?? ''} onChange={(event) => updateFilter('libraryId', event.target.value || undefined)}><option value="">All content</option>{libraries.data?.map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}</select></Field>
          <Field label="Type"><select value={filters.contentTypes?.[0] ?? ''} onChange={(event) => updateFilter('contentTypes', event.target.value ? [event.target.value as ContentType] : undefined)}><option value="">All types</option>{CONTENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></Field>
          <Field label="Source"><select value={filters.sources?.[0] ?? ''} onChange={(event) => updateFilter('sources', event.target.value ? [event.target.value] : undefined)}><option value="">All sources</option><option value="claude-code">Claude</option><option value="codex">Codex</option><option value="cowork">Cowork</option><option value="local-ui">Manual import</option></select></Field>
          <Field label="Tag"><select value={filters.tags?.[0] ?? ''} onChange={(event) => updateFilter('tags', event.target.value ? [event.target.value] : undefined)}><option value="">All tags</option>{tags.data?.map((tag) => <option key={tag.id} value={tag.slug}>{tag.label}</option>)}</select></Field>
          <Field label="Status"><select value={filters.status ?? ''} onChange={(event) => updateFilter('status', event.target.value ? event.target.value as ContentFilters['status'] : undefined)}><option value="">Active + archived</option><option value="active">Active</option><option value="archived">Archived</option></select></Field>
          <Field label="From"><input type="date" value={filters.dateFrom?.slice(0, 10) ?? ''} onChange={(event) => updateDateFilter('dateFrom', event.target.value)} /></Field>
          <Field label="To"><input type="date" value={filters.dateTo?.slice(0, 10) ?? ''} onChange={(event) => updateDateFilter('dateTo', event.target.value)} /></Field>
          <Field label="Sort"><select value={filters.sortBy} onChange={(event) => updateFilter('sortBy', event.target.value as ContentSort)}><option value="createdAt">Date</option><option value="title">Title</option><option value="contentType">Type</option><option value="source">Source</option><option value="status">Status</option></select></Field>
          <Field label="Direction"><select value={filters.sortDirection} onChange={(event) => updateFilter('sortDirection', event.target.value as 'asc' | 'desc')}><option value="desc">Descending</option><option value="asc">Ascending</option></select></Field>
        </div>
      </div>
      {selected.size ? <div className="bulk-bar" role="status"><strong>{selected.size} selected</strong><Button onClick={() => setBulkOpen(true)}>Organize</Button><SelectedContentBatchButton contentIds={[...selected]} /><Button variant="danger" onClick={() => setDeleteOpen(true)}>Delete</Button><Button variant="quiet" onClick={() => setSelected(new Set())}>Clear</Button></div> : null}
      {query.error ? <Notice kind="error">{errorMessage(query.error, 'Unable to load content.')}</Notice> : null}
      {query.isLoading ? <LoadingState label="Loading content" /> : null}
      {!query.isLoading && !items.length ? <EmptyState title="No content found">Import supported history or clear filters to see more records.</EmptyState> : null}
      {items.length ? (
        <div className="table-frame">
          <div className="table-meta"><span>{query.data?.meta.total ?? items.length} records</span><span>PAGE {cursorHistory.length}</span></div>
          <div className="table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="Select all content" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))} /></th><th>Title</th><th>Type</th><th>Source</th><th>Status</th><th>Tags</th><th>Created</th></tr></thead><tbody>{items.map((item) => <ContentRow key={item.id} item={item} selected={selected.has(item.id)} onSelect={() => toggle(item.id)} onOpen={() => setDetailId(item.id)} />)}</tbody></table></div>
          <div className="pagination"><Button variant="secondary" disabled={cursorHistory.length === 1} onClick={() => setCursorHistory((history) => history.slice(0, -1))}>Previous</Button><Button variant="secondary" disabled={!query.data?.meta.hasMore || !query.data.meta.nextCursor} onClick={() => setCursorHistory((history) => [...history, query.data?.meta.nextCursor ?? undefined])}>Next</Button></div>
        </div>
      ) : null}
      <ContentInspector contentId={detailId} onClose={() => setDetailId(null)} />
      <BulkOrganizeDialog open={bulkOpen} contentIds={[...selected]} onClose={() => setBulkOpen(false)} />
      <BulkDeleteDialog open={deleteOpen} contentIds={[...selected]} onClose={() => setDeleteOpen(false)} onDone={() => setSelected(new Set())} />
    </section>
  );
}

function ContentRow({ item, selected, onSelect, onOpen }: { item: ContentItem; selected: boolean; onSelect(): void; onOpen(): void }) {
  return <tr><td><input type="checkbox" aria-label={`Select ${item.title}`} checked={selected} onChange={onSelect} /></td><td><button className="table-link" onClick={onOpen}><strong>{item.title}</strong><small>{item.summary || 'No summary available'}</small></button></td><td><span className="type-pill">{item.contentType}</span></td><td>{sourceLabel(item.source)}</td><td><span className={`status-pill ${item.status}`}>{item.status ?? 'active'}</span></td><td><div className="tag-list">{item.tags?.map((tag) => <TagChip key={tag.id} label={tag.label} color={tag.color} />)}</div></td><td>{formatDate(item.createdAt)}</td></tr>;
}

function sourceLabel(source?: string) {
  const labels: Record<string, string> = { 'claude-code': 'Claude', codex: 'Codex', cowork: 'Cowork', 'local-ui': 'Manual' };
  return source ? labels[source] ?? source : 'Unknown';
}

export function ContentInspector({ contentId, onClose }: { contentId: string | null; onClose(): void }) {
  const [tab, setTab] = useState<'summary' | 'raw' | 'metadata' | 'lineage' | 'artifacts' | 'archive'>('summary');
  const detail = useContentDetail(contentId);
  const lineage = useContentLineage(contentId);
  const artifacts = useContentArtifacts(contentId);
  const blobs = useContentBlobs(contentId);
  const item = detail.data;
  const tabs = ['summary', 'raw', 'metadata', 'lineage', 'artifacts', 'archive'] as const;
  return <Dialog open={Boolean(contentId)} title={item?.title ?? 'Content inspector'} description={item ? `${item.contentType} · ${sourceLabel(item.source)} · ${item.status}` : 'Loading content detail'} onClose={onClose}>
    {detail.error ? <Notice kind="error">{errorMessage(detail.error, 'Unable to load content detail.')}</Notice> : null}
    {!item && !detail.error ? <LoadingState label="Loading inspector" /> : item ? <><div className="tab-list" role="tablist">{tabs.map((name) => <button role="tab" aria-selected={tab === name} key={name} onClick={() => setTab(name)}>{name}</button>)}</div><div className="inspector-panel" role="tabpanel">
      {tab === 'summary' ? <><h3>Summary</h3><p className="prose-copy">{item.summary || 'No summary has been generated.'}</p><dl className="detail-grid"><dt>Source ID</dt><dd>{item.sourceIdentifier}</dd><dt>Conversation</dt><dd>{item.conversationId ?? '—'}</dd><dt>Created</dt><dd>{formatDate(item.createdAt)}</dd><dt>Tags</dt><dd><div className="tag-list">{item.tags?.map((tag) => <TagChip key={tag.id} label={tag.label} color={tag.color} />)}</div></dd></dl></> : null}
      {tab === 'raw' ? <><h3>Raw content</h3><pre>{item.content || 'No raw text is stored.'}</pre></> : null}
      {tab === 'metadata' ? <JsonPanel title="Source metadata" value={{ sourceData: item.sourceData, metadata: item.metadata, analysisData: item.analysisData, turnMetadata: item.turnMetadata }} /> : null}
      {tab === 'lineage' ? lineage.isLoading ? <LoadingState /> : <JsonPanel title="Lineage" value={lineage.data ?? {}} /> : null}
      {tab === 'artifacts' ? artifacts.isLoading ? <LoadingState /> : <ArtifactBrowser artifacts={artifacts.data ?? []} /> : null}
      {tab === 'archive' ? <><JsonPanel title="Raw archive manifest" value={item.rawArchiveManifest ?? lineage.data?.origin?.rawArchiveManifest ?? {}} /><h3>Attachments</h3>{blobs.data?.length ? <ul className="file-list">{blobs.data.map((blob) => <li key={blob.id}><a href={`/api/v1/blobs/${blob.id}/download`}>{blob.fileName}</a><span>{blob.mediaType} · {blob.byteSize} bytes</span></li>)}</ul> : <p>No raw archive attachments are registered.</p>}</> : null}
    </div></> : null}
  </Dialog>;
}

function JsonPanel({ title, value }: { title: string; value: unknown }) { return <><h3>{title}</h3><pre>{JSON.stringify(value, null, 2)}</pre></>; }

function ArtifactBrowser({ artifacts }: { artifacts: Artifact[] }) {
  const groups = useMemo(() => [...new Set(artifacts.map((artifact) => artifact.artifactType))], [artifacts]);
  const [type, setType] = useState(groups[0] ?? '');
  const versions = artifacts.filter((artifact) => artifact.artifactType === (groups.includes(type) ? type : groups[0]));
  const [artifactId, setArtifactId] = useState('');
  const selected = versions.find((artifact) => artifact.id === artifactId) ?? versions[0];
  if (!artifacts.length) return <p>No artifacts.</p>;
  const body = selected?.textContent ?? JSON.stringify(selected?.dataJson ?? {}, null, 2);
  const isMarkdown = selected?.artifactType.includes('report') || selected?.metadata?.format === 'markdown';
  return <div className="artifact-browser"><div className="tab-list" role="tablist" aria-label="Artifact types">{groups.map((name) => <button role="tab" aria-selected={(selected?.artifactType ?? groups[0]) === name} key={name} onClick={() => { setType(name); setArtifactId(''); }}>{name}</button>)}</div>{selected ? <><div className="artifact-toolbar"><Field label="Version"><select value={selected.id} onChange={(event) => setArtifactId(event.target.value)}>{versions.map((artifact) => <option key={artifact.id} value={artifact.id}>v{artifact.version}{artifact.isCurrent ? ' · current' : ''} · {formatDate(artifact.createdAt)}</option>)}</select></Field><Button variant="secondary" onClick={() => downloadTextFile(`${selected.artifactType}-v${selected.version}.${isMarkdown ? 'md' : selected.dataJson ? 'json' : 'txt'}`, body, isMarkdown ? 'text/markdown' : selected.dataJson ? 'application/json' : 'text/plain')}>Download version</Button></div><dl className="detail-grid"><dt>Status</dt><dd>{selected.status}{selected.isCurrent ? ' · current' : ''}</dd><dt>Recipe version</dt><dd>{selected.recipeVersion ?? 'Base artifact'}</dd><dt>Prompt hash</dt><dd><code>{selected.promptHash?.slice(0, 16) ?? '—'}</code></dd><dt>Model</dt><dd>{selected.modelId ?? '—'}</dd><dt>Lineage</dt><dd>{selected.sourceContentIds?.join(', ') || selected.supersedesId || '—'}</dd></dl>{isMarkdown && selected.textContent ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.textContent}</ReactMarkdown></div> : <pre>{body}</pre>}</> : null}</div>;
}

function BulkOrganizeDialog({ open, contentIds, onClose }: { open: boolean; contentIds: string[]; onClose(): void }) {
  const tags = useTags(); const libraries = useLibraries(); const assign = useAssignTag(); const membership = useSetLibraryMembership();
  const [tagId, setTagId] = useState(''); const [libraryId, setLibraryId] = useState(''); const [mode, setMode] = useState<'include' | 'exclude'>('include');
  const [batchError, setBatchError] = useState('');
  function applyTags(assigned: boolean) { if (!tagId) return; assign.mutate({ tagId, contentIds, assigned }, { onSuccess: onClose }); }
  async function applyMembership(active: boolean) { if (!libraryId) return; setBatchError(''); const results = await Promise.allSettled(contentIds.map((contentId) => membership.mutateAsync({ libraryId, contentId, mode, active }))); const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected'); if (failure) setBatchError(errorMessage(failure.reason, 'Unable to organize the selected content.')); else onClose(); }
  const mutationError = assign.error ?? membership.error;
  return <Dialog open={open} title="Organize selected content" description={`${contentIds.length} records selected`} onClose={onClose}><div className="form-grid">{batchError || mutationError ? <Notice kind="error">{batchError || errorMessage(mutationError, 'Unable to organize the selected content.')}</Notice> : null}<Field label="Tag"><select value={tagId} onChange={(event) => setTagId(event.target.value)}><option value="">Choose a tag</option>{tags.data?.map((tag) => <option key={tag.id} value={tag.id}>{tag.label}</option>)}</select></Field><div className="dialog-actions"><Button disabled={!tagId} onClick={() => applyTags(true)}>Assign tag</Button><Button variant="secondary" disabled={!tagId} onClick={() => applyTags(false)}>Unassign tag</Button></div><hr /><Field label="Library"><select value={libraryId} onChange={(event) => setLibraryId(event.target.value)}><option value="">Choose a library</option>{libraries.data?.filter((library) => library.kind === 'user_defined').map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}</select></Field><Field label="Override"><select value={mode} onChange={(event) => setMode(event.target.value as 'include' | 'exclude')}><option value="include">Manual include</option><option value="exclude">Manual exclude</option></select></Field><div className="dialog-actions"><Button disabled={!libraryId} onClick={() => void applyMembership(true)}>Apply override</Button><Button variant="secondary" disabled={!libraryId} onClick={() => void applyMembership(false)}>Remove override</Button></div></div></Dialog>;
}

function BulkDeleteDialog({ open, contentIds, onClose, onDone }: { open: boolean; contentIds: string[]; onClose(): void; onDone(): void }) {
  const remove = useDeleteContent();
  const [batchError, setBatchError] = useState('');
  async function confirm() { setBatchError(''); const results = await Promise.allSettled(contentIds.map((id) => remove.mutateAsync(id))); const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected'); if (failure) setBatchError(errorMessage(failure.reason, 'Unable to delete the selected content.')); else { onDone(); onClose(); } }
  return <ConfirmDialog open={open} title="Delete selected content?" busy={remove.isPending} onClose={onClose} onConfirm={() => void confirm()}>This archives {contentIds.length} records from active workflows. Raw source archives remain outside the content row where configured.{batchError || remove.error ? <Notice kind="error">{batchError || errorMessage(remove.error, 'Unable to delete the selected content.')}</Notice> : null}</ConfirmDialog>;
}
