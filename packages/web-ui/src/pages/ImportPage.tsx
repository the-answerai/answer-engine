import { type ChangeEvent, type FormEvent, useEffect, useMemo, useState } from 'react';
import { Button, Field, LoadingState, Notice, PageHeader, errorMessage } from '../components';
import {
  useApproveFirstImport,
  useCancelFirstImport,
  useImportContent,
  useLatestFirstImport,
  useLibraries,
  usePreviewImport,
  useRetryFirstImport,
  useApproveFolderRun,
  useCancelFolderRun,
  useLatestFolderSource,
  usePrepareFolderRemoval,
  useRetryFolderRun,
} from '../hooks';
import type { ContentType, FirstImportSourceId, ImportItem, ImportResult } from '../types';
import { CONTENT_TYPES } from '../types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function LocalFolderImport() {
  const latest = useLatestFolderSource();
  const approve = useApproveFolderRun();
  const cancel = useCancelFolderRun();
  const retry = useRetryFolderRun();
  const remove = usePrepareFolderRemoval();
  const source = latest.data;
  const [consented, setConsented] = useState(false);
  const [retention, setRetention] = useState<'keep' | 'delete'>('keep');
  const [removeConfirmed, setRemoveConfirmed] = useState(false);
  if (latest.isLoading) return <div className="panel first-import-empty"><LoadingState label="Looking for selected folders" /></div>;
  if (latest.error) return <Notice kind="error">{errorMessage(latest.error, 'Unable to load local folder status.')}</Notice>;
  if (!source || !source.latestRun) return <div className="panel first-import-empty folder-empty">
    <span className="figure">LOCAL FOLDER / EXPLICIT ACCESS</span><h2>Choose a folder on this computer</h2>
    <p>Run <code>ae folders add &lt;exact-folder-path&gt;</code>. The command records file names, types, sizes, exclusions, and a small binary-classification sample, then pauses here.</p>
    <Notice kind="info">No full document bytes are archived or ingested until you approve the displayed root and policy.</Notice>
  </div>;
  const run = source.latestRun;
  const candidates = run.items.filter((item) => item.disposition === 'candidate');
  const warnings = run.items.filter((item) => item.disposition !== 'candidate');
  const reconciled = run.items.filter((item) => item.outcome !== 'pending').length;
  const active = ['approved', 'running', 'cancel_requested'].includes(run.status);
  const final = ['completed', 'failed', 'canceled'].includes(run.status);
  const dispositionCounts = Object.entries(run.inventoryCounts)
    .filter(([key, value]) => !['total', 'bytes'].includes(key) && value > 0);
  return <div className="first-import-layout">
    <section className="panel first-import-main folder-import-main">
      <header className="panel-head"><div><span className="figure">PREVIEW-FIRST FOLDER</span><h2>Local folder</h2></div><span className={`status-pill ${run.status}`}>{run.status.replace('_', ' ')}</span></header>
      <p className="first-import-lede">Review the exact selected root and limits. Symlinks are reported and never followed.</p>
      <dl className="folder-policy">
        <div><dt>Selected root</dt><dd><code>{source.rootPath}</code></dd></div>
        <div><dt>Includes</dt><dd>{source.includePatterns.join(', ')}</dd></div>
        <div><dt>Ignores</dt><dd>{source.excludePatterns.length ? source.excludePatterns.join(', ') : 'None configured'}</dd></div>
        <div><dt>Limits</dt><dd>{formatBytes(source.maxFileBytes)} per file · {formatBytes(source.maxTotalBytes)} total</dd></div>
        <div><dt>Symlinks</dt><dd>Do not follow</dd></div>
      </dl>
      <div className="folder-summary" role="group" aria-label="Folder inventory summary">
        <div><strong>{candidates.length}</strong><span>approved candidates</span></div>
        <div><strong>{formatBytes(candidates.reduce((sum, item) => sum + item.byteSize, 0))}</strong><span>estimated work</span></div>
        <div><strong>{warnings.length}</strong><span>warnings / exclusions</span></div>
      </div>
      <div className="folder-dispositions">{dispositionCounts.map(([key, value]) => <span key={key}><strong>{value}</strong> {key.replace('_', ' ')}</span>)}</div>
      <details className="folder-inventory"><summary>Inspect all {run.items.length} preview rows</summary>
        <div className="folder-inventory-list">{run.items.map((item) => <article key={item.relativePath}>
          <div><strong>{item.relativePath}</strong><small>{item.fileType ?? 'path'} · {formatBytes(item.byteSize)}</small></div>
          <span className={`status-pill ${item.change ?? item.disposition}`}>{(item.change ?? item.disposition).replace('_', ' ')}</span><p>{item.reason}</p>
        </article>)}</div>
      </details>
      {run.status === 'previewed' ? <div className="consent-box">
        <label><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} /> I approve this exact folder root, inventory, and safety policy</label>
        <p>Only candidate rows in this preview may be read. New or changed files require a fresh preview.</p>
        <Button disabled={!consented || candidates.length === 0 || approve.isPending} onClick={() => approve.mutate(run.id)}>{approve.isPending ? 'Approving…' : `Approve ${candidates.length} document${candidates.length === 1 ? '' : 's'}`}</Button>
        <Button variant="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate(run.id)}>Cancel preview</Button>
      </div> : null}
      {approve.error ? <Notice kind="error">{errorMessage(approve.error, 'Folder approval failed.')}</Notice> : null}
      {active ? <div className="import-progress" aria-live="polite">
        <div><strong>{run.status === 'approved' ? 'Approved — waiting for the local importer' : run.status === 'cancel_requested' ? 'Stopping between files…' : 'Archiving and importing approved files…'}</strong><span>{reconciled} / {run.items.length} reconciled</span></div>
        <progress aria-label="Local folder ingestion progress" max={Math.max(run.items.length, 1)} value={reconciled} />
        <p>Resume safely with <code>ae folders resume --source {source.id}</code>. Changed or new files are never read in this run.</p>
        <Button variant="secondary" disabled={cancel.isPending || run.status === 'cancel_requested'} onClick={() => cancel.mutate(run.id)}>Cancel safely</Button>
      </div> : null}
      {cancel.error ? <Notice kind="error">{errorMessage(cancel.error, 'Unable to cancel folder ingestion.')}</Notice> : null}
      {final ? <div className="reconciliation" aria-live="polite"><h3>{run.status === 'completed' ? 'Inventory reconciled' : run.status === 'canceled' ? 'Folder ingestion canceled safely' : 'Folder ingestion needs attention'}</h3>
        <div className="reconciliation-grid">{(['previewed', 'imported', 'updated', 'duplicate', 'excluded', 'changed', 'failed', 'skipped', 'missing'] as const).map((key) => <div key={key}><strong>{run.counts[key] ?? 0}</strong><span>{key}</span></div>)}</div>
        <p>Run <code>ae folders refresh --source {source.id}</code> to preview added, changed, unchanged, missing, and excluded paths.</p>
        {run.status !== 'completed' ? <Button variant="secondary" disabled={retry.isPending} onClick={() => retry.mutate(run.id)}>{retry.isPending ? 'Preparing…' : 'Retry failed or interrupted files'}</Button> : null}
      </div> : null}
      {retry.data ? <Notice kind="info">Retry prepared. Run <code>ae folders resume --source {source.id}</code>.</Notice> : null}
      {retry.error ? <Notice kind="error">{errorMessage(retry.error, 'Unable to prepare folder retry.')}</Notice> : null}
      {source.status !== 'removed' ? <details className="folder-removal"><summary>Remove this folder source</summary>
        <fieldset><legend>Retention choice</legend><label><input type="radio" name="retention" checked={retention === 'keep'} onChange={() => setRetention('keep')} /> Keep imported memories and local archives</label><label><input type="radio" name="retention" checked={retention === 'delete'} onChange={() => setRetention('delete')} /> Delete mapped memories and source-owned archives</label></fieldset>
        <label><input type="checkbox" checked={removeConfirmed} onChange={(event) => setRemoveConfirmed(event.target.checked)} /> I understand this choice will be recorded in the local audit log</label>
        <Button variant="secondary" disabled={!removeConfirmed || remove.isPending} onClick={() => remove.mutate({ sourceId: source.id, retention })}>{remove.isPending ? 'Preparing removal…' : `Prepare ${retention} removal`}</Button>
        {remove.data ? <Notice kind="info">Removal prepared. Complete local archive handling with <code>ae folders remove {source.id} --retention {retention}</code>.</Notice> : null}
        {remove.error ? <Notice kind="error">{errorMessage(remove.error, 'Unable to prepare folder removal.')}</Notice> : null}
      </details> : <Notice kind="success">Folder source removed with {source.retention} retention.</Notice>}
    </section>
    <aside className="panel first-import-trust"><span className="figure">LOCAL TRUST BOUNDARY</span><ol><li>You pass one exact root to the local CLI.</li><li>Metadata and a bounded binary sample explain every path.</li><li>Approval unlocks only unchanged candidates.</li><li>Archives preserve bytes and SHA-256 lineage.</li><li>Refresh and removal require another explicit choice.</li></ol></aside>
  </div>;
}

function AgentHistoryImport() {
  const latest = useLatestFirstImport();
  const approve = useApproveFirstImport();
  const cancel = useCancelFirstImport();
  const retry = useRetryFirstImport();
  const session = latest.data;
  const [selected, setSelected] = useState<FirstImportSourceId[]>([]);
  const [consented, setConsented] = useState(false);
  useEffect(() => {
    if (!session) return;
    setSelected(session.status === 'discovered'
      ? session.sources.filter((source) => source.availability === 'available').map((source) => source.sourceId)
      : session.selectedSourceIds);
  }, [session?.id, session?.status, session?.selectedSourceIds]);

  if (latest.isLoading) return <div className="panel first-import-empty"><LoadingState label="Looking for agent history" /></div>;
  if (latest.error) return <Notice kind="error">{errorMessage(latest.error, 'Unable to load first-import status.')}</Notice>;
  if (!session || !Array.isArray(session.sources) || !session.counts) return <div className="panel first-import-empty">
    <span className="figure">WELCOME / LOCAL HISTORY</span>
    <h2>Bring your agent history with you</h2>
    <p>Run <code>ae sync first-import</code> on this computer. It inventories supported history using file names and statistics only, then waits here for your approval before reading any transcript.</p>
    <Notice kind="info">Nothing is imported until you review and approve at least one discovered source.</Notice>
  </div>;

  const total = session.sources.reduce((sum, source) => sum + source.estimatedCount, 0);
  const reconciled = session.counts.imported + session.counts.duplicate + session.counts.failed + session.counts.skipped;
  const selecting = session.status === 'discovered';
  const active = ['approved', 'running', 'cancel_requested'].includes(session.status);
  const final = ['completed', 'failed', 'canceled'].includes(session.status);
  function toggle(sourceId: FirstImportSourceId) {
    setSelected((value) => value.includes(sourceId)
      ? value.filter((candidate) => candidate !== sourceId)
      : [...value, sourceId]);
  }

  return <div className="first-import-layout">
    <section className="panel first-import-main">
      <header className="panel-head"><div><span className="figure">CONSENT-FIRST IMPORT</span><h2>Your agent history</h2></div><span className={`status-pill ${session.status}`}>{session.status.replace('_', ' ')}</span></header>
      <p className="first-import-lede">Choose any combination below. Discovery has not read transcript bodies, created archives, or changed your memory.</p>
      <div className="source-preview-list">
        {session.sources.map((source) => <article className="source-preview" key={source.sourceId}>
          <label className="source-choice">
            <input type="checkbox" aria-label={source.label} checked={selected.includes(source.sourceId)} disabled={!selecting || source.availability !== 'available'} onChange={() => toggle(source.sourceId)} />
            <span><strong>{source.label}</strong><small>{source.estimatedCount} conversation{source.estimatedCount === 1 ? '' : 's'} · {formatBytes(source.estimatedBytes)} · {source.availability.replace('_', ' ')}</small></span>
          </label>
          <div className="source-detail"><span className="figure">SOURCE PATH{source.paths.length === 1 ? '' : 'S'}</span>{source.paths.map((path) => <code key={path}>{path}</code>)}</div>
          <p>{source.privacyPosture}</p>
          <p className="availability-note">{source.availabilityNote}</p>
          <details><summary>Expected exclusions</summary><ul>{source.exclusions.map((exclusion) => <li key={exclusion}>{exclusion}</li>)}</ul></details>
          {source.errorCode ? <Notice kind="error"><strong>{source.label}: {source.errorCode}</strong>{source.recoveryAction ? <> · {source.recoveryAction}</> : null}</Notice> : null}
        </article>)}
      </div>
      {selecting ? <div className="consent-box">
        <label><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} /> I understand what Answer Engine will read</label>
        <p>Only the selected source transcripts will be read. Raw archives and searchable summaries stay in this local runtime.</p>
        <Button disabled={!consented || selected.length === 0 || approve.isPending} onClick={() => approve.mutate({ sessionId: session.id, sourceIds: selected })}>
          {approve.isPending ? 'Approving…' : `Approve ${selected.length} source${selected.length === 1 ? '' : 's'}`}
        </Button>
      </div> : null}
      {approve.error ? <Notice kind="error">{errorMessage(approve.error, 'Approval failed.')}</Notice> : null}
      {active ? <div className="import-progress" aria-live="polite">
        <div><strong>{session.status === 'approved' ? 'Approved — waiting for the local importer' : session.status === 'cancel_requested' ? 'Stopping safely…' : 'Importing approved history…'}</strong><span>{reconciled} / {total} reconciled</span></div>
        <progress aria-label="Agent history import progress" max={Math.max(total, 1)} value={reconciled} />
        <p>You can close this page. Run <code>ae sync first-import --resume {session.id}</code> if the local command was interrupted.</p>
        <Button variant="secondary" disabled={cancel.isPending || session.status === 'cancel_requested'} onClick={() => cancel.mutate(session.id)}>Cancel safely</Button>
      </div> : null}
      {cancel.error ? <Notice kind="error">{errorMessage(cancel.error, 'Unable to cancel the import.')}</Notice> : null}
      {final ? <div className="reconciliation" aria-live="polite">
        <h3>{session.status === 'completed' ? 'Import reconciled' : session.status === 'canceled' ? 'Import canceled safely' : 'Import needs attention'}</h3>
        <div className="reconciliation-grid">
          {(['discovered', 'imported', 'duplicate', 'failed', 'skipped'] as const).map((key) => <div key={key}><strong>{key === 'discovered' ? total : session.counts[key]}</strong><span>{key}</span></div>)}
        </div>
        <p>{reconciled === total ? 'Every discovered history has a recorded outcome.' : `${total - reconciled} histories still need an outcome.`}</p>
        {session.status !== 'completed' ? <Button variant="secondary" disabled={retry.isPending} onClick={() => retry.mutate(session.id)}>{retry.isPending ? 'Preparing…' : 'Retry failed or interrupted items'}</Button> : null}
        {retry.data ? <Notice kind="info">Retry prepared. Run <code>ae sync first-import --resume {session.id}</code>.</Notice> : null}
      </div> : null}
      {retry.error ? <Notice kind="error">{errorMessage(retry.error, 'Unable to prepare a retry.')}</Notice> : null}
    </section>
    <aside className="panel first-import-trust">
      <span className="figure">WHAT HAPPENS NEXT</span>
      <ol><li>Approve only the sources you recognize.</li><li>The local CLI archives and imports one history at a time.</li><li>Durable cursors make interruption and retry safe.</li><li>The final inventory reconciles every discovered history.</li></ol>
      <p>Folder scanning and automatic organization are separate, opt-in workflows.</p>
    </aside>
  </div>;
}

function ManualImport({ mode }: { mode: 'text' | 'json' }) {
  const libraries = useLibraries(); const preview = usePreviewImport(); const importer = useImportContent();
  const [title, setTitle] = useState(''); const [content, setContent] = useState(''); const [jsonText, setJsonText] = useState(''); const [contentType, setContentType] = useState<ContentType>('document'); const [libraryId, setLibraryId] = useState(''); const [parseError, setParseError] = useState(''); const [items, setItems] = useState<ImportItem[]>([]); const [result, setResult] = useState<ImportResult | null>(null);
  const currentItems = useMemo(() => mode === 'text' ? title.trim() && content.trim() ? [{ title: title.trim(), content, contentType, source: 'local-ui', sourceIdentifier: `local-ui:${crypto.randomUUID()}`, metadata: { importedBy: 'local-ui' } }] : [] : items, [mode, title, content, contentType, items]);
  function parseJson(value: string) { setJsonText(value); setParseError(''); try { const parsed: unknown = JSON.parse(value); const candidate = Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed && 'items' in parsed ? (parsed as { items: unknown }).items : [parsed]; if (!Array.isArray(candidate) || candidate.some((item) => !item || typeof item !== 'object' || typeof (item as { title?: unknown }).title !== 'string')) throw new Error('JSON must contain objects with a title field.'); setItems(candidate as ImportItem[]); } catch (error) { setItems([]); setParseError(errorMessage(error, 'Invalid JSON.')); } }
  async function fileChange(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; parseJson(await file.text()); }
  function submitPreview(event: FormEvent) { event.preventDefault(); setResult(null); if (!currentItems.length) { setParseError('Add at least one valid item before previewing.'); return; } preview.mutate({ items: currentItems, libraryId: libraryId || undefined }); }
  function runImport() { importer.mutate({ items: currentItems, libraryId: libraryId || undefined }, { onSuccess: setResult }); }
  return <div className="import-layout"><form className="panel import-form" onSubmit={submitPreview}>
    <Field label="Destination library"><select value={libraryId} onChange={(event) => setLibraryId(event.target.value)}><option value="">Personal memory</option>{libraries.data?.map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}</select></Field>
    <Field label="Content type"><select value={contentType} onChange={(event) => setContentType(event.target.value as ContentType)}>{CONTENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></Field>
    {mode === 'text' ? <><Field label="Title"><input required value={title} onChange={(event) => setTitle(event.target.value)} /></Field><Field label="Content"><textarea required rows={16} value={content} onChange={(event) => setContent(event.target.value)} placeholder="Paste a note, transcript, page, or document…" /></Field></> : <><Field label="Choose JSON file" hint="A JSON array or an object with an items array"><input type="file" accept="application/json,.json" onChange={(event) => void fileChange(event)} /></Field><Field label="JSON data"><textarea rows={16} value={jsonText} onChange={(event) => parseJson(event.target.value)} placeholder={'[{"title":"Decision", "content":"…", "source":"codex"}]'} /></Field></>}
    {parseError ? <Notice kind="error">{parseError}</Notice> : null}{preview.error ? <Notice kind="error">{errorMessage(preview.error, 'Preview failed.')}</Notice> : null}<Button type="submit" disabled={preview.isPending}>{preview.isPending ? 'Checking…' : 'Preview import'}</Button></form>
    <aside className="panel import-preview"><header className="panel-head"><div><span className="figure">VALIDATION PLATE</span><h2>Preview</h2></div><span>{preview.data?.rowCount ?? currentItems.length} rows</span></header>{!preview.data ? <p className="empty-copy">Build the import on the left, then preview it against the server’s validated content contract.</p> : <><div className="preview-list">{preview.data.sample.map((item, index) => <article key={`${item.title}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{item.title}</strong><small>{item.contentType ?? item.content_type ?? contentType} · {item.source ?? 'local-ui'}</small><p>{item.content?.slice(0, 180) || 'No text projection'}</p></div></article>)}</div><Button onClick={runImport} disabled={importer.isPending}>{importer.isPending ? 'Importing…' : `Import ${preview.data.rowCount} item${preview.data.rowCount === 1 ? '' : 's'}`}</Button></>}{importer.error ? <Notice kind="error">{errorMessage(importer.error, 'Import failed.')}</Notice> : null}{result ? <div className="import-result"><Notice kind={result.failedItems ? 'error' : 'success'}>{result.completedItems} imported · {result.failedItems} failed</Notice>{result.failures.length ? <ul>{result.failures.map((failure) => <li key={failure.rowIndex}>Row {failure.rowIndex + 1}: {failure.error}</li>)}</ul> : null}</div> : null}</aside>
  </div>;
}

export function ImportPage() {
  const [mode, setMode] = useState<'agent' | 'folder' | 'text' | 'json'>('agent');
  return <section className="workspace-page"><PageHeader eyebrow="FIG. 02 / INGEST" title="Import" description="Preview local history, selected folders, or manual content before it becomes memory." />
    <div className="panel mode-switch import-mode-switch" role="group" aria-label="Import source">
      <button type="button" className={mode === 'agent' ? 'active' : ''} onClick={() => setMode('agent')}>Agent history</button>
      <button type="button" className={mode === 'folder' ? 'active' : ''} onClick={() => setMode('folder')}>Local folder</button>
      <button type="button" className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>Manual text</button>
      <button type="button" className={mode === 'json' ? 'active' : ''} onClick={() => setMode('json')}>JSON / file batch</button>
    </div>
    {mode === 'agent' ? <AgentHistoryImport /> : mode === 'folder' ? <LocalFolderImport /> : <ManualImport key={mode} mode={mode} />}
  </section>;
}
