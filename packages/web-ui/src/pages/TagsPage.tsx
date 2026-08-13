import { type FormEvent, useState } from 'react';
import { Button, ConfirmDialog, Dialog, EmptyState, Field, LoadingState, Notice, PageHeader, SubmitForm, TagChip, errorMessage } from '../components';
import { useCreateTag, useDeleteTag, useTags, useUpdateTag } from '../hooks';
import type { Tag } from '../types';

const emptyForm = { label: '', slug: '', description: '', category: '', parentId: '', color: '#1B3A8F' };

export function TagsPage() {
  const tags = useTags();
  const create = useCreateTag();
  const update = useUpdateTag();
  const remove = useDeleteTag();
  const [editing, setEditing] = useState<Tag | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Tag | null>(null);
  const grouped = Object.entries((tags.data ?? []).reduce<Record<string, Tag[]>>((result, tag) => {
    const category = tag.category || 'Uncategorized';
    result[category] = [...(result[category] ?? []), tag];
    return result;
  }, {}));
  function confirmDelete() { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) }); }
  return <section className="workspace-page"><PageHeader eyebrow="FIG. 03 / TAXONOMY" title="Tags" description="Build a reusable taxonomy and assign it across your local content." actions={<Button onClick={() => setEditing('new')}>Create tag</Button>} />
    {tags.error ? <Notice kind="error">{errorMessage(tags.error, 'Unable to load tags.')}</Notice> : null}
    {tags.isLoading ? <LoadingState label="Loading taxonomy" /> : null}
    {!tags.isLoading && !tags.data?.length ? <EmptyState title="No tags yet" action={<Button onClick={() => setEditing('new')}>Create first tag</Button>}>Tags make content and library filters easier to reuse.</EmptyState> : null}
    <div className="taxonomy-grid">{grouped.map(([category, categoryTags]) => <section className="taxonomy-group" key={category}><header><span className="figure">CATEGORY</span><h2>{category}</h2><span>{categoryTags?.length ?? 0}</span></header><div>{categoryTags?.map((tag) => <article className="tag-card" key={tag.id}><div><TagChip label={tag.label} color={tag.color} /><strong>{tag.slug}</strong><p>{tag.description || 'No description'}</p>{tag.parentId ? <small>CHILD TAG</small> : null}</div><div className="row-actions"><Button variant="quiet" onClick={() => setEditing(tag)}>Edit</Button><Button variant="danger" onClick={() => setDeleting(tag)}>Delete</Button></div></article>)}</div></section>)}</div>
    <TagForm key={editing === 'new' ? 'new' : editing?.id ?? 'closed'} open={Boolean(editing)} tag={editing === 'new' ? undefined : editing ?? undefined} tags={tags.data ?? []} busy={create.isPending || update.isPending} error={editing === 'new' ? create.error : update.error} onClose={() => setEditing(null)} onSubmit={async (input) => { try { if (editing === 'new') await create.mutateAsync(input); else if (editing) await update.mutateAsync({ id: editing.id, input }); setEditing(null); } catch { /* The mutation error stays visible and the form remains open. */ } }} />
    <ConfirmDialog open={Boolean(deleting)} title="Delete tag?" busy={remove.isPending} onClose={() => setDeleting(null)} onConfirm={confirmDelete}>The tag “{deleting?.label}” will be removed from active taxonomy and content assignments.{remove.error ? <Notice kind="error">{errorMessage(remove.error, 'Unable to delete the tag.')}</Notice> : null}</ConfirmDialog>
  </section>;
}

function TagForm({ open, tag, tags, busy, error, onClose, onSubmit }: { open: boolean; tag?: Tag; tags: Tag[]; busy: boolean; error: unknown; onClose(): void; onSubmit(input: { label: string; slug: string; description: string | null; category: string | null; parentId: string | null; color: string | null; metadata: Record<string, unknown> }): Promise<void> }) {
  const [form, setForm] = useState(() => tag ? {
    label: tag.label,
    slug: tag.slug,
    description: tag.description ?? '',
    category: tag.category ?? '',
    parentId: tag.parentId ?? '',
    color: tag.color ?? '#1B3A8F',
  } : emptyForm);
  function value(name: keyof typeof form, input: string) { setForm((current) => ({ ...current, [name]: input })); }
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await onSubmit({ label: form.label.trim(), slug: form.slug || slugify(form.label), description: form.description || null, category: form.category || null, parentId: form.parentId || null, color: form.color || null, metadata: tag?.metadata ?? {} }); }
  return <Dialog open={open} title={tag ? 'Edit tag' : 'Create tag'} onClose={onClose}><SubmitForm onSubmit={(event) => void submit(event)}>{error ? <Notice kind="error">{errorMessage(error, 'Unable to save the tag.')}</Notice> : null}<Field label="Label"><input required value={form.label} onChange={(event) => value('label', event.target.value)} /></Field><Field label="Slug" hint="Lowercase words separated by hyphens"><input pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={form.slug} onChange={(event) => value('slug', event.target.value)} /></Field><Field label="Description"><textarea rows={3} value={form.description} onChange={(event) => value('description', event.target.value)} /></Field><Field label="Category"><input value={form.category} onChange={(event) => value('category', event.target.value)} /></Field><Field label="Parent"><select value={form.parentId} onChange={(event) => value('parentId', event.target.value)}><option value="">No parent</option>{tags.filter((candidate) => candidate.id !== tag?.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></Field><Field label="Color"><input type="color" value={form.color} onChange={(event) => value('color', event.target.value)} /></Field><div className="dialog-actions"><Button variant="secondary" type="button" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save tag'}</Button></div></SubmitForm></Dialog>;
}

function slugify(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120); }
