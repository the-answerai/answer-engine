import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { clearLegacyBrowserApiKey, health, initializeLocalUiSession } from './api';
import { LoadingState, Notice } from './components';
import { AnswersPage } from './pages/AnswersPage';
import { ContentPage } from './pages/ContentPage';
import { ImportPage } from './pages/ImportPage';
import { LibrariesPage, LibraryPage } from './pages/LibrariesPage';
import { TagsPage } from './pages/TagsPage';
import { BatchJobsPage } from './pages/BatchJobsPage';
import { SettingsPage } from './pages/SettingsPage';

const navigation = [
  { to: '/content', label: 'Content', mark: '01' },
  { to: '/import', label: 'Import', mark: '02' },
  { to: '/tags', label: 'Tags', mark: '03' },
  { to: '/libraries', label: 'Libraries', mark: '04' },
  { to: '/answers', label: 'Answers', mark: '05' },
  { to: '/batch-jobs', label: 'Batch Jobs', mark: '06' },
  { to: '/settings', label: 'Settings', mark: '07' },
];

function LocalSessionGate() {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const bootstrap = useCallback(async () => {
    setState('loading');
    clearLegacyBrowserApiKey();
    try {
      await initializeLocalUiSession();
      if (!await health()) throw new Error('The local API health check failed.');
      setState('ready');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to connect to the local Answer Engine.');
      setState('error');
    }
  }, []);
  useEffect(() => { void bootstrap(); }, [bootstrap]);
  if (state === 'loading') return <div className="session-screen"><LoadingState label="Opening local workspace" /></div>;
  if (state === 'error') return <div className="session-screen"><Notice kind="error">{message} <button onClick={() => void bootstrap()}>Retry</button></Notice></div>;
  return <AppShell />;
}

function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigationRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const navigation = navigationRef.current;
    const links = [...(navigation?.querySelectorAll<HTMLAnchorElement>('a') ?? [])];
    queueMicrotask(() => links[0]?.focus());
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { setMenuOpen(false); return; }
      if (event.key !== 'Tab' || !links.length) return;
      const first = links[0]; const last = links[links.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); menuButtonRef.current?.focus(); };
  }, [menuOpen]);
  return (
    <div className="shell">
      <a href="#workspace" className="skip-link">Skip to workspace</a>
      {menuOpen ? <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand-block"><span className="brand-mark">AE</span><div><strong>Answer Engine</strong><small>LOCAL WORKSPACE</small></div></div>
        <nav ref={navigationRef} aria-label="Primary">
          {navigation.map((item) => (
            <NavLink key={item.to} to={item.to} onClick={() => setMenuOpen(false)} className={({ isActive }) => isActive ? 'active' : ''}>
              <span>{item.mark}</span>{item.label}
            </NavLink>
          ))}
        </nav>
        <div className="local-badge"><span className="status-mark online" />LOCAL SESSION<small>No login or API key required</small></div>
      </aside>
      <div className="shell-body">
        <header className="mobile-header"><button ref={menuButtonRef} aria-label="Open navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>☰</button><strong>Answer Engine</strong><span>LOCAL</span></header>
        <main id="workspace" tabIndex={-1}><Outlet /></main>
      </div>
    </div>
  );
}

export function App() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: 1, staleTime: 15_000 } },
  }));
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<LocalSessionGate />}>
            <Route path="/" element={<Navigate to="/content" replace />} />
            <Route path="/content" element={<ContentPage />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/tags" element={<TagsPage />} />
            <Route path="/libraries" element={<LibrariesPage />} />
            <Route path="/libraries/:libraryId" element={<LibraryPage />} />
            <Route path="/libraries/:libraryId/answers" element={<AnswersPage />} />
            <Route path="/libraries/:libraryId/:section" element={<LibraryPage />} />
            <Route path="/answers" element={<AnswersPage />} />
            <Route path="/batch-jobs" element={<BatchJobsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/content" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
