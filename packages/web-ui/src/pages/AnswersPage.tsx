import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useParams } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { askAnswer } from '../api';
import { Button, Field, Notice, PageHeader, errorMessage } from '../components';
import { useLibrary, useTags } from '../hooks';
import type { ContentType } from '../types';
import { CONTENT_TYPES } from '../types';
import { ContentInspector } from './ContentPage';

export function AnswersPage() {
  const { libraryId } = useParams(); const library = useLibrary(libraryId); const tags = useTags();
  const [question, setQuestion] = useState(''); const [contentType, setContentType] = useState<ContentType | ''>(''); const [tag, setTag] = useState(''); const [citationId, setCitationId] = useState<string | null>(null);
  const ask = useMutation({ mutationFn: askAnswer });
  function submit(event: FormEvent) { event.preventDefault(); ask.mutate({ question: question.trim(), ...(libraryId ? { libraryId } : {}), filters: { ...(contentType ? { contentTypes: [contentType] } : {}), ...(tag ? { tagSlugs: [tag] } : {}) } }); }
  const heading = libraryId ? library.data?.name ? `Answers · ${library.data.name}` : 'Library answers' : 'Answers';
  return <section className="workspace-page"><PageHeader eyebrow="FIG. 05 / GROUNDED RETRIEVAL" title={heading} description={libraryId ? 'Ask questions grounded only in this library’s effective membership.' : 'Ask questions over all local content and open every cited source.'} actions={libraryId ? <Link className="button secondary" to={`/libraries/${libraryId}`}>Back to library</Link> : undefined} />
    <div className="answers-layout"><form className="panel ask-form" onSubmit={submit}><Field label="Question"><textarea required minLength={3} rows={6} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What did I decide about…?" /></Field><div className="filter-row"><Field label="Content type"><select value={contentType} onChange={(event) => setContentType(event.target.value as ContentType | '')}><option value="">All types</option>{CONTENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></Field><Field label="Tag"><select value={tag} onChange={(event) => setTag(event.target.value)}><option value="">All tags</option>{tags.data?.map((item) => <option key={item.id} value={item.slug}>{item.label}</option>)}</select></Field></div><Button type="submit" disabled={ask.isPending}>{ask.isPending ? 'Retrieving + grounding…' : 'Ask local memory'}</Button>{ask.error ? <Notice kind="error">{errorMessage(ask.error, 'The question failed.')}</Notice> : null}</form>
      <section className="panel answer-panel" aria-live="polite"><header className="panel-head"><div><span className="figure">ANSWER PLATE</span><h2>Grounded response</h2></div>{ask.data?.provider ? <small>{ask.data.provider} · {ask.data.modelId}</small> : null}</header>{!ask.data ? <div className="answer-placeholder"><strong>Evidence before inference.</strong><p>Your answer and real citations will appear here.</p></div> : <article className="answer"><ReactMarkdown remarkPlugins={[remarkGfm]}>{ask.data.answer}</ReactMarkdown><h3>Citations</h3>{ask.data.citations.length ? <ol>{ask.data.citations.map((citation, index) => <li key={`${citation.contentId ?? citation.id}-${index}`}><button onClick={() => setCitationId(citation.contentId ?? citation.id ?? null)}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{citation.title || 'Local source'}</strong><small>{citation.contentType} {citation.relevanceScore !== undefined ? `· score ${citation.relevanceScore.toFixed(3)}` : ''}</small><p>{citation.excerpt}</p></div></button></li>)}</ol> : <Notice>No citations were returned. Treat this answer as unsupported.</Notice>}</article>}</section></div>
    <ContentInspector contentId={citationId} onClose={() => setCitationId(null)} />
  </section>;
}
