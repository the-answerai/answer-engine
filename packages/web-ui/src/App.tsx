import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  askMemory,
  clearLegacyBrowserApiKey,
  health,
  importMemory,
  initializeLocalUiSession,
  inspectLineage,
  listMemories,
  searchMemories,
  type AskResult,
  type LineageResult,
  type MemoryItem,
} from './api';

type View = 'memory' | 'ask' | 'import';

function itemTitle(item: MemoryItem): string {
  return item.title || item.summary || item.content?.slice(0, 72) || 'Untitled memory';
}

export function App() {
  const [view, setView] = useState<View>('memory');
  const [connected, setConnected] = useState(false);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [selected, setSelected] = useState<MemoryItem | null>(null);
  const [lineage, setLineage] = useState<LineageResult | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await initializeLocalUiSession();
      const healthy = await health();
      setConnected(healthy);
      if (healthy) setItems(await listMemories());
    } catch (cause) {
      setConnected(false);
      setError(cause instanceof Error ? cause.message : 'Unable to reach the local engine');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    clearLegacyBrowserApiKey();
    void refresh();
  }, [refresh]);

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setItems(query.trim() ? await searchMemories(query.trim()) : await listMemories());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Search failed');
    } finally {
      setBusy(false);
    }
  }

  async function selectItem(item: MemoryItem) {
    setSelected(item);
    setLineage(null);
    setError('');
    try {
      setLineage(await inspectLineage(item.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Lineage inspection failed');
    }
  }

  return (
    <div className="app-grid">
      <header className="title-block">
        <div>
          <span className="eyebrow">LOCAL MEMORY SYSTEM · REV 1.1</span>
          <h1>Answer Engine</h1>
        </div>
        <nav aria-label="Primary">
          <button className={view === 'memory' ? 'active' : ''} onClick={() => setView('memory')}>Memory</button>
          <button className={view === 'ask' ? 'active' : ''} onClick={() => setView('ask')}>Ask</button>
          <button className={view === 'import' ? 'active' : ''} onClick={() => setView('import')}>Import</button>
        </nav>
        <div className="status" aria-live="polite">
          <span className={connected ? 'status-mark online' : 'status-mark'} />
          {connected ? 'API ONLINE' : 'API OFFLINE'}
        </div>
      </header>

      {error ? <div className="error-banner" role="alert">{error}</div> : null}

      <main>
        {view === 'memory' ? (
          <MemoryView
            busy={busy}
            items={items}
            lineage={lineage}
            query={query}
            selected={selected}
            onQuery={setQuery}
            onRefresh={() => void refresh()}
            onSearch={runSearch}
            onSelect={(item) => void selectItem(item)}
          />
        ) : null}
        {view === 'ask' ? <AskView /> : null}
        {view === 'import' ? <ImportView onImported={() => { setView('memory'); void refresh(); }} /> : null}
      </main>
    </div>
  );
}

interface MemoryViewProps {
  busy: boolean;
  items: MemoryItem[];
  lineage: LineageResult | null;
  query: string;
  selected: MemoryItem | null;
  onQuery(value: string): void;
  onRefresh(): void;
  onSearch(event: FormEvent): void;
  onSelect(item: MemoryItem): void;
}

function MemoryView(props: MemoryViewProps) {
  return (
    <section className="memory-workbench" aria-labelledby="memory-title">
      <div className="section-head">
        <div><span className="figure">FIG. 02</span><h2 id="memory-title">Memory index</h2></div>
        <button className="secondary" onClick={props.onRefresh} disabled={props.busy}>Refresh</button>
      </div>
      <form className="search-line" onSubmit={props.onSearch}>
        <label htmlFor="search">Full-text retrieval</label>
        <input id="search" value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="Search remembered work…" />
        <button type="submit" disabled={props.busy}>{props.busy ? 'Tracing…' : 'Search'}</button>
      </form>
      <div className="memory-layout">
        <div className="memory-list" aria-label="Memory results">
          {props.items.length === 0 ? <div className="empty">No memories found.</div> : null}
          {props.items.map((item, index) => (
            <button key={item.id} className={props.selected?.id === item.id ? 'memory-row selected' : 'memory-row'} onClick={() => props.onSelect(item)}>
              <span className="index">{String(index + 1).padStart(2, '0')}</span>
              <span><strong>{itemTitle(item)}</strong><small>{item.contentType ?? 'memory'} · {item.id}</small></span>
              {typeof (item.relevanceScore ?? item.score) === 'number'
                ? <span className="score">{(item.relevanceScore ?? item.score as number).toFixed(3)}</span>
                : null}
            </button>
          ))}
        </div>
        <MemoryInspector item={props.selected} lineage={props.lineage} />
      </div>
    </section>
  );
}

function MemoryInspector({ item, lineage }: { item: MemoryItem | null; lineage: LineageResult | null }) {
  const lineageText = useMemo(() => lineage ? JSON.stringify(lineage.lineage ?? lineage, null, 2) : '', [lineage]);
  return (
    <aside className="inspector" aria-label="Memory inspector">
      <span className="figure">FIG. 03</span>
      <h2>Source + lineage</h2>
      {!item ? <p className="empty">Select a memory to inspect its content and supersession chain.</p> : (
        <>
          <dl><dt>Content ID</dt><dd>{item.id}</dd><dt>Type</dt><dd>{item.contentType ?? 'memory'}</dd></dl>
          <div className="content-copy">{item.content ?? item.summary ?? 'No content projection returned.'}</div>
          <pre>{lineageText || 'Tracing lineage…'}</pre>
        </>
      )}
    </aside>
  );
}

function AskView() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AskResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try { setResult(await askMemory(question.trim())); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Question failed'); }
    finally { setBusy(false); }
  }

  return (
    <section className="ask-panel" aria-labelledby="ask-title">
      <div className="section-head"><div><span className="figure">FIG. 04</span><h2 id="ask-title">Grounded answer</h2></div></div>
      <form onSubmit={submit}>
        <label htmlFor="question">Question over local memory</label>
        <textarea id="question" value={question} onChange={(event) => setQuestion(event.target.value)} rows={4} required placeholder="What did I decide about…?" />
        <button type="submit" disabled={busy}>{busy ? 'Retrieving + grounding…' : 'Ask memory'}</button>
      </form>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {result ? (
        <article className="answer">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.answer}</ReactMarkdown>
          <h3>Citations</h3>
          <ol>{result.citations.map((citation, index) => <li key={`${citation.contentId ?? citation.id}-${index}`}><strong>{citation.title ?? citation.source ?? 'Memory'}</strong><code>{citation.contentId ?? citation.id}</code>{citation.excerpt ? <p>{citation.excerpt}</p> : null}</li>)}</ol>
        </article>
      ) : null}
    </section>
  );
}

function ImportView({ onImported }: { onImported(): void }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await importMemory({ title, content }); onImported(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Import failed'); }
    finally { setBusy(false); }
  }
  return (
    <section className="import-panel" aria-labelledby="import-title">
      <div className="section-head"><div><span className="figure">FIG. 05</span><h2 id="import-title">Remember text</h2></div></div>
      <form onSubmit={submit}>
        <label htmlFor="title">Title</label><input id="title" value={title} onChange={(event) => setTitle(event.target.value)} required />
        <label htmlFor="content">Content</label><textarea id="content" value={content} onChange={(event) => setContent(event.target.value)} rows={14} required />
        <button type="submit" disabled={busy}>{busy ? 'Indexing…' : 'Remember'}</button>
      </form>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
    </section>
  );
}
