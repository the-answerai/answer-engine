import { useEffect, useState } from 'react';
import { Button, EmptyState, LoadingState, Notice, PageHeader, errorMessage } from '../components';
import { useCheckRecallTutorial, useCreateRecallTutorial, useRecallTutorialCapabilities, useRecallTutorials } from '../hooks';
import type { RecallTutorial, RecallTutorialClient } from '../types';

const failures = ['runtime', 'wiring', 'access', 'indexing', 'retrieval'] as const;

export function RecallTutorialPage() {
  const [environment, setEnvironment] = useState<'native' | 'wsl'>('native');
  const capabilities = useRecallTutorialCapabilities(environment);
  const tutorials = useRecallTutorials();
  const create = useCreateRecallTutorial();
  const check = useCheckRecallTutorial();
  const [writeClient, setWriteClient] = useState<RecallTutorialClient>('codex');
  const [recallClient, setRecallClient] = useState<RecallTutorialClient>('codex');
  const [active, setActive] = useState<RecallTutorial>();
  const tutorial = active ?? tutorials.data?.[0];
  const supported = capabilities.data?.filter((item) => item.supported) ?? [];
  useEffect(() => {
    if (!supported.length) return;
    if (!supported.some((item) => item.id === writeClient)) setWriteClient(supported[0]!.id);
    if (!supported.some((item) => item.id === recallClient)) setRecallClient(supported[0]!.id);
  }, [supported.map((item) => item.id).join(','), writeClient, recallClient]);
  const pageError = capabilities.error ?? tutorials.error ?? create.error ?? check.error;
  const diagnosticMessage = tutorial?.diagnostic.details.message ?? tutorial?.diagnostic.details.recovery;

  return <section className="workspace-page recall-tutorial-page">
    <PageHeader eyebrow="FIG. 06 / PROOF" title="Prove your first memory" description="Remember a harmless fact in one chat, recall it in a genuinely fresh chat, and verify the source tool evidence." />
    {pageError ? <Notice kind="error">{errorMessage(pageError, 'The first-memory proof could not continue.')}</Notice> : null}
    <section className="panel tutorial-preflight">
      <header className="panel-head"><div><span className="figure">CLIENT PREFLIGHT</span><h2>Choose the two chat surfaces</h2></div></header>
      <div className="tutorial-selectors">
        <label>Environment<select value={environment} onChange={(event) => setEnvironment(event.target.value as 'native' | 'wsl')}><option value="native">Native desktop</option><option value="wsl">Windows 11 + WSL2</option></select></label>
        <label>Remember in<select value={writeClient} onChange={(event) => setWriteClient(event.target.value as RecallTutorialClient)}>{supported.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Recall in a fresh chat<select value={recallClient} onChange={(event) => setRecallClient(event.target.value as RecallTutorialClient)}>{supported.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      </div>
      <p>{writeClient === recallClient ? 'Same-client proof' : 'Cross-client proof'} · completion requires audited remember, recall, and inspect_memory calls.</p>
      <Button disabled={!supported.length || create.isPending} onClick={() => create.mutate({ writeClient, recallClient, environment }, { onSuccess: setActive })}>{create.isPending ? 'Creating…' : 'Start harmless proof'}</Button>
      <details><summary>Why some clients are unavailable</summary><ul>{capabilities.data?.filter((item) => !item.supported).map((item) => <li key={item.id}><strong>{item.label}:</strong> {item.limitation}</li>)}</ul></details>
    </section>
    {capabilities.isLoading || tutorials.isLoading ? <LoadingState label="Checking local client paths" /> : null}
    {!tutorial && !tutorials.isLoading ? <EmptyState title="No proof started">Choose supported clients above. Answer Engine generates the fact; do not use a secret or personal detail.</EmptyState> : null}
    {tutorial ? <section className="tutorial-steps">
      <article className="panel tutorial-step"><span className="figure">STEP 1 / FIRST CHAT</span><h2>Remember the generated fact</h2><p className="tutorial-fact">{tutorial.fact}</p><pre>{tutorial.instructions.remember.text}</pre><small>Expected idempotency key: {tutorial.sourceIdentifier}</small></article>
      <article className="panel tutorial-step"><span className="figure">STEP 2 / FRESH CHAT</span><h2>Recall without copying the answer</h2><Notice>The prompt below contains the opaque marker only. It does not contain “cobalt” or any answer-bearing context.</Notice><pre>{tutorial.instructions.freshChat.text}</pre></article>
      <article className="panel tutorial-step"><span className="figure">STEP 3 / TOOL EVIDENCE</span><h2>{tutorial.status === 'verified' ? 'Proof passed' : 'Check the audit trail'}</h2>
        {tutorial.status === 'verified' ? <Notice kind="success">A real recall returned {tutorial.contentId}, followed by inspect_memory source evidence.</Notice> : <><p>Status: <strong>{tutorial.diagnostic.code.replaceAll('_', ' ')}</strong></p>{diagnosticMessage ? <Notice>{String(diagnosticMessage)}</Notice> : null}<Button disabled={check.isPending} onClick={() => check.mutate({ id: tutorial.id }, { onSuccess: setActive })}>{check.isPending ? 'Checking…' : 'Check tool evidence'}</Button><details><summary>Report a failure for targeted help</summary><div className="page-actions">{failures.map((failure) => <Button key={failure} variant="secondary" onClick={() => check.mutate({ id: tutorial.id, reportedFailure: failure }, { onSuccess: setActive })}>{failure}</Button>)}</div></details></>}
      </article>
    </section> : null}
  </section>;
}
