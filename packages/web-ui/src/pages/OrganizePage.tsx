import { useEffect, useState } from 'react';
import { Button, ConfirmDialog, EmptyState, LoadingState, Notice, PageHeader, errorMessage, formatDate } from '../components';
import {
  useApplyOrganizationPlan,
  useCreateOrganizationProposal,
  useOrganizationPlans,
  useUndoOrganizationPlan,
} from '../hooks';
import type { OrganizationDecision, OrganizationPlan, OrganizationSuggestion } from '../types';

function suggestionTitle(suggestion: OrganizationSuggestion): string {
  if (suggestion.type === 'tag.create') return `Create tag “${suggestion.tag.label}”`;
  if (suggestion.type === 'tag.assign') return `Assign tag “${suggestion.tagSlug}” to ${suggestion.contentIds.length} records`;
  return `Create library “${suggestion.library.name}”`;
}

export function OrganizePage() {
  const plans = useOrganizationPlans();
  const propose = useCreateOrganizationProposal();
  const apply = useApplyOrganizationPlan();
  const undo = useUndoOrganizationPlan();
  const [active, setActive] = useState<OrganizationPlan>();
  const [useModel, setUseModel] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, OrganizationDecision['decision']>>({});
  const [confirmUndo, setConfirmUndo] = useState(false);
  const plan = active ?? plans.data?.[0];
  const reviewable = plan?.status === 'preview' || plan?.status === 'undone';
  useEffect(() => {
    if (!plan) return;
    setDecisions(Object.fromEntries((plan.decisions ?? []).map((item) => [item.suggestionId, item.decision])));
  }, [plan?.id, plan?.status]);
  const allDecided = Boolean(plan && plan.suggestions.every((suggestion) => decisions[suggestion.id]));
  const pageError = plans.error ?? propose.error ?? apply.error ?? undo.error;

  function createProposal() {
    propose.mutate({ useModel, limit: 50 }, { onSuccess: (created) => setActive(created) });
  }

  function applyPlan() {
    if (!plan || !allDecided) return;
    apply.mutate({
      planId: plan.id,
      decisions: plan.suggestions.map((suggestion) => ({
        suggestionId: suggestion.id,
        decision: decisions[suggestion.id]!,
      })),
    }, { onSuccess: (applied) => setActive(applied) });
  }

  return <section className="workspace-page organization-page">
    <PageHeader
      eyebrow="FIG. 05 / ORGANIZATION"
      title="Organize memory"
      description="Generate an evidence-backed diff, decide every suggestion, then apply or undo it without changing imported source content."
      actions={<Button onClick={createProposal} disabled={propose.isPending}>{propose.isPending ? 'Analyzing…' : 'Create proposal'}</Button>}
    />
    {pageError ? <Notice kind="error">{errorMessage(pageError, 'The organization workflow could not continue.')}</Notice> : null}
    <section className="panel organization-policy">
      <header className="panel-head"><div><span className="figure">PRIVACY BOUNDARY</span><h2>Bounded metadata only</h2></div></header>
      <p>Proposal generation uses up to 50 IDs, titles, 500-character summaries, source/type fields, and existing tag names. It never sends full content or raw archives.</p>
      <label className="consent-row"><input type="checkbox" checked={useModel} onChange={(event) => setUseModel(event.target.checked)} />Use my explicitly configured model for this proposal</label>
      <small>Leave this off for deterministic local source grouping. Turning it on sends only the bounded fields above to your configured provider.</small>
    </section>
    {plans.isLoading ? <LoadingState label="Loading organization proposals" /> : null}
    {!plans.isLoading && !plan ? <EmptyState title="No proposal yet" action={<Button onClick={createProposal}>Create local proposal</Button>}>Nothing changes until every suggestion is reviewed and applied.</EmptyState> : null}
    {plan ? <div className="organization-layout">
      <aside className="panel organization-history">
        <header className="panel-head"><div><span className="figure">PLAN HISTORY</span><h2>Recent proposals</h2></div></header>
        <div className="selectable-list">{plans.data?.map((item) => <button key={item.id} className={item.id === plan.id ? 'selected' : ''} onClick={() => setActive(item)}><span><strong>{item.proposalMode === 'model' ? 'Model proposal' : 'Local proposal'}</strong><small>{formatDate(item.createdAt)} · {item.suggestions.length} suggestions</small></span><span className={`status-pill ${item.status}`}>{item.status}</span></button>)}</div>
      </aside>
      <section className="panel organization-review">
        <header className="panel-head"><div><span className="figure">REVIEWED DIFF</span><h2>{plan.suggestions.length} suggestions from {plan.sampleCount} records</h2></div><span className={`status-pill ${plan.status}`}>{plan.status}</span></header>
        {plan.suggestions.length === 0 ? <Notice kind="success">No new tags, assignments, or libraries are needed for this snapshot.</Notice> : null}
        <div className="organization-suggestions">{plan.suggestions.map((suggestion) => <article className="organization-suggestion" key={suggestion.id}>
          <header><div><span className="figure">{suggestion.type.toUpperCase()}</span><h3>{suggestionTitle(suggestion)}</h3></div><strong>{Math.round(suggestion.confidence * 100)}%</strong></header>
          <p>{suggestion.rationale}</p>
          {suggestion.dependsOn.length ? <small>Requires accepted suggestion: {suggestion.dependsOn.join(', ')}</small> : null}
          <details><summary>Supporting source examples ({suggestion.evidence.length})</summary><ul>{suggestion.evidence.map((item) => <li key={item.contentId}><strong>{item.title}</strong><span>{item.source} · {item.contentId.slice(0, 8)}</span></li>)}</ul></details>
          <fieldset disabled={!reviewable}><legend>Decision for {suggestionTitle(suggestion)}</legend><label><input type="radio" name={`decision-${suggestion.id}`} checked={decisions[suggestion.id] === 'accept'} onChange={() => setDecisions((current) => ({ ...current, [suggestion.id]: 'accept' }))} />Accept</label><label><input type="radio" name={`decision-${suggestion.id}`} checked={decisions[suggestion.id] === 'reject'} onChange={() => setDecisions((current) => ({ ...current, [suggestion.id]: 'reject' }))} />Reject</label></fieldset>
        </article>)}</div>
        <footer className="organization-actions">
          {reviewable ? <><span>{Object.keys(decisions).length} of {plan.suggestions.length} decided</span><Button disabled={!allDecided || apply.isPending || plan.suggestions.length === 0} onClick={applyPlan}>{apply.isPending ? 'Applying…' : plan.status === 'undone' ? 'Reapply reviewed plan' : 'Apply reviewed plan'}</Button></> : null}
          {plan.status === 'applied' ? <><Notice kind="success">Applied with an audit record. Imported content was not rewritten.</Notice><Button variant="danger" onClick={() => setConfirmUndo(true)}>Undo this plan</Button></> : null}
          {plan.status === 'undone' ? <Notice>Undo completed. Imported content stayed intact; review the decisions above to reapply without duplicates.</Notice> : null}
        </footer>
      </section>
    </div> : null}
    <ConfirmDialog open={confirmUndo} title="Undo organization plan?" confirmLabel="Undo plan" busy={undo.isPending} onClose={() => setConfirmUndo(false)} onConfirm={() => plan && undo.mutate(plan.id, { onSuccess: (undone) => { setActive(undone); setConfirmUndo(false); } })}>Only tags, libraries, and assignments introduced by this plan will be reverted. Imported content will stay intact.</ConfirmDialog>
  </section>;
}
