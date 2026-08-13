import { type FormEvent, useEffect, useState } from 'react';
import { downloadTextFile, rowsToCsv } from '../api';
import { Button, Dialog, EmptyState, Field, LoadingState, Notice, PageHeader, SubmitForm, errorMessage, formatDate } from '../components';
import { useBatchJob, useBatchJobs, useCancelBatchJob, useCreateBatchJob, useLibraries, useRetryBatchJob, useSettings } from '../hooks';
import type { BatchJob } from '../types';

function canRetry(status: BatchJob['status']) { return ['failed', 'partial_success', 'canceled'].includes(status); }

export function BatchJobsPage() {
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([undefined]);
  const [selectedId, setSelectedId] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const jobs = useBatchJobs(cursorHistory.at(-1));
  const detail = useBatchJob(selectedId);
  const cancel = useCancelBatchJob();
  const retry = useRetryBatchJob();
  const settings = useSettings();
  const actionError = jobs.error ?? detail.error ?? cancel.error ?? retry.error;
  return <section className="workspace-page"><PageHeader eyebrow="FIG. 06 / OPERATIONS" title="Batch jobs" description="Run large local prompt and export operations with durable progress, results, failures, and recovery controls." actions={<Button onClick={() => setCreateOpen(true)}>Create batch job</Button>} />{actionError ? <Notice kind="error">{errorMessage(actionError, 'The batch operation failed.')}</Notice> : null}{jobs.isLoading ? <LoadingState label="Loading batch jobs" /> : !jobs.data?.items.length ? <EmptyState title="No batch jobs">Start a prompt or export job over a library or selected content.</EmptyState> : <div className="advanced-layout"><section className="panel"><div className="selectable-list">{jobs.data.items.map((job) => <button key={job.id} className={selectedId === job.id ? 'selected' : ''} onClick={() => setSelectedId(job.id)}><span><strong>{job.name}</strong><small>{job.kind} · {formatDate(job.createdAt)}</small></span><span className={`status-pill ${job.status}`}>{job.status.replace('_', ' ')}</span></button>)}</div><div className="pagination"><Button variant="secondary" disabled={cursorHistory.length === 1} onClick={() => setCursorHistory((value) => value.slice(0, -1))}>Previous</Button><Button variant="secondary" disabled={!jobs.data.hasMore || !jobs.data.nextCursor} onClick={() => setCursorHistory((value) => [...value, jobs.data?.nextCursor ?? undefined])}>Next</Button></div></section>{detail.data ? <BatchDetail job={detail.data} preferredFormat={settings.data?.defaultExportFormat ?? 'json'} onCancel={() => cancel.mutate(detail.data.id)} onRetry={() => retry.mutate(detail.data.id)} /> : <section className="panel"><EmptyState title="Select a job">Inspect progress and per-item output.</EmptyState></section>}</div>}<BatchJobForm open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(id) => { setSelectedId(id); setCreateOpen(false); }} /></section>;
}

function BatchDetail({ job, preferredFormat, onCancel, onRetry }: { job: BatchJob; preferredFormat: 'json' | 'csv' | 'markdown'; onCancel(): void; onRetry(): void }) {
  const percent = job.totalCount ? Math.round((job.processedCount / job.totalCount) * 100) : 0;
  const rows = (job.results ?? []).map((result) => ({ contentId: result.contentId, status: result.status, output: result.output, error: result.errorMessage }));
  const formats = [preferredFormat, ...(['json', 'csv', 'markdown'] as const).filter((format) => format !== preferredFormat)];
  return <section className="panel"><header className="panel-head"><div><span className="figure">JOB DETAIL / {job.kind.toUpperCase()}</span><h2>{job.name}</h2></div><div className="page-actions">{['queued', 'running'].includes(job.status) ? <Button variant="danger" onClick={onCancel}>Cancel</Button> : null}{canRetry(job.status) ? <Button onClick={onRetry}>Retry safely</Button> : null}{formats.map((format, index) => <Button key={format} variant={index === 0 ? 'primary' : 'secondary'} onClick={() => exportBatch(job, rows, format)}>{format}</Button>)}</div></header><div className="progress-block"><div><span className={`status-pill ${job.status}`}>{job.status.replace('_', ' ')}</span><strong>{job.processedCount}/{job.totalCount}</strong><small>{job.succeededCount} succeeded · {job.failedCount} failed</small></div><progress max={100} value={percent}>{percent}%</progress></div>{job.errorMessage ? <Notice kind="error">{job.errorMessage}</Notice> : null}<details><summary>Job input</summary><pre>{JSON.stringify(job.input, null, 2)}</pre></details><div className="result-stack">{job.results?.map((result) => <article key={result.id}><header><strong>{result.contentId}</strong><span className={`status-pill ${result.status}`}>{result.status}</span></header>{result.output ? <pre>{typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)}</pre> : null}{result.errorMessage ? <Notice kind="error">{result.errorMessage}</Notice> : null}</article>)}</div></section>;
}

function exportBatch(job: BatchJob, rows: Array<Record<string, unknown>>, format: 'json' | 'csv' | 'markdown') {
  if (format === 'json') {
    downloadTextFile(`${job.name}.json`, JSON.stringify(job, null, 2), 'application/json');
    return;
  }
  if (format === 'csv') {
    downloadTextFile(`${job.name}.csv`, rowsToCsv(rows), 'text/csv');
    return;
  }
  const markdown = rows.map((row) => `## ${String(row.contentId)}\n\n**Status:** ${String(row.status)}\n\n\`\`\`json\n${JSON.stringify(row.output ?? row.error ?? null, null, 2)}\n\`\`\``).join('\n\n');
  downloadTextFile(`${job.name}.md`, `# ${job.name}\n\n${markdown}`, 'text/markdown');
}

function BatchJobForm({ open, initialContentIds = [], onClose, onCreated }: { open: boolean; initialContentIds?: string[]; onClose(): void; onCreated(id: string): void }) {
  const create = useCreateBatchJob(); const libraries = useLibraries(); const settings = useSettings(); const [name, setName] = useState(''); const [kind, setKind] = useState<'prompt' | 'export'>('prompt'); const [libraryId, setLibraryId] = useState(''); const [prompt, setPrompt] = useState(''); const [format, setFormat] = useState<'json' | 'csv' | 'markdown'>('json'); const [contentIds, setContentIds] = useState(initialContentIds.join(','));
  const initialContentIdsValue = initialContentIds.join(',');
  useEffect(() => {
    if (!open) return;
    setContentIds(initialContentIdsValue);
    setLibraryId(initialContentIds.length ? '' : settings.data?.defaultLibraryId ?? '');
    setFormat(settings.data?.defaultExportFormat ?? 'json');
  }, [open, initialContentIds.length, initialContentIdsValue, settings.data]);
  async function submit(event: FormEvent) { event.preventDefault(); try { const ids = contentIds.split(',').map((id) => id.trim()).filter(Boolean); const job = await create.mutateAsync({ name: name.trim(), kind, libraryId: libraryId || null, input: kind === 'prompt' ? { prompt } : { format }, ...(ids.length ? { contentIds: ids } : {}) }); onCreated(job.id); } catch { /* error remains in dialog */ } }
  return <Dialog open={open} title="Create batch job" description="Provider-neutral local work" onClose={onClose}><SubmitForm onSubmit={(event) => void submit(event)}>{create.error ? <Notice kind="error">{errorMessage(create.error, 'Unable to create batch job.')}</Notice> : null}<Field label="Name"><input required value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Kind"><select value={kind} onChange={(event) => setKind(event.target.value as 'prompt' | 'export')}><option value="prompt">Prompt</option><option value="export">Export</option></select></Field><Field label="Library"><select value={libraryId} onChange={(event) => setLibraryId(event.target.value)}><option value="">All local content / selected IDs</option>{libraries.data?.map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}</select></Field>{kind === 'prompt' ? <Field label="Prompt"><textarea required rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></Field> : <Field label="Export format"><select value={format} onChange={(event) => setFormat(event.target.value as typeof format)}><option value="json">JSON</option><option value="csv">CSV</option><option value="markdown">Markdown</option></select></Field>}<Field label="Content IDs" hint="Optional comma-separated IDs; a library job uses all effective members."><textarea value={contentIds} onChange={(event) => setContentIds(event.target.value)} /></Field><div className="dialog-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={create.isPending}>{create.isPending ? 'Queueing…' : 'Queue job'}</Button></div></SubmitForm></Dialog>;
}

export function SelectedContentBatchButton({ contentIds }: { contentIds: string[] }) {
  const [open, setOpen] = useState(false);
  return <><Button variant="secondary" onClick={() => setOpen(true)}>Batch</Button><BatchJobForm open={open} initialContentIds={contentIds} onClose={() => setOpen(false)} onCreated={() => setOpen(false)} /></>;
}
