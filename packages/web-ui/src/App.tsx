import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { LoadingState, Notice } from './components';
import {
  createWebComposition,
  type VisibleWebComposition,
  type WebAppExtensions,
  type WebComposition,
  type WebIdentity,
} from './composition';
import { coreRouteManifest, type CoreSurfaceManifest } from './core-manifest';
import { useSettings } from './hooks';
import { AnswersPage } from './pages/AnswersPage';
import { BatchJobsPage } from './pages/BatchJobsPage';
import { ContentPage } from './pages/ContentPage';
import { ImportPage } from './pages/ImportPage';
import { LibrariesPage, LibraryPage } from './pages/LibrariesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TagsPage } from './pages/TagsPage';

function LocalSessionGate({ composition }: { composition: WebComposition }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [identity, setIdentity] = useState<WebIdentity>();
  const [message, setMessage] = useState('');
  const bootstrap = useCallback(async () => {
    setState('loading');
    try {
      setIdentity(await composition.identity.bootstrap());
      setState('ready');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to connect to the local Answer Engine.');
      setState('error');
    }
  }, [composition]);
  useEffect(() => { void bootstrap(); }, [bootstrap]);
  if (state === 'loading') return <div className="session-screen"><LoadingState label="Opening local workspace" /></div>;
  if (state === 'error') return <div className="session-screen"><Notice kind="error">{message} <button onClick={() => void bootstrap()}>Retry</button></Notice></div>;
  if (!identity) return null;
  return <AppShell composition={composition} identity={identity} />;
}

function AppShell({ composition, identity }: { composition: WebComposition; identity: WebIdentity }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const settings = useSettings();
  const navigationRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const visible = composition.forIdentity(identity);
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
    <div className={`shell density-${settings.data?.density ?? 'comfortable'}`}>
      <a href="#workspace" className="skip-link">Skip to workspace</a>
      {menuOpen ? <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand-block"><span className="brand-mark">AE</span><div><strong>Answer Engine</strong><small>{identity.workspaceLabel ?? 'WORKSPACE'}</small></div></div>
        {identity.channel === 'staging' ? <div className="staging-indicator" data-testid="staging-sidebar-indicator">STAGING</div> : null}
        <nav ref={navigationRef} aria-label="Primary">
          {visible.navigation.map((item) => (
            <NavLink key={item.id} to={item.to} onClick={() => setMenuOpen(false)} className={({ isActive }) => isActive ? 'active' : ''}>
              <span>{item.mark}</span>{item.label}
            </NavLink>
          ))}
        </nav>
        <div className="local-badge">
          {composition.identity.render
            ? composition.identity.render(identity)
            : <><span className="status-mark online" />{identity.label}<small>{identity.detail}</small></>}
        </div>
      </aside>
      <div className="shell-body">
        <header className="mobile-header"><button ref={menuButtonRef} aria-label="Open navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>☰</button><strong>Answer Engine</strong><span data-testid={identity.channel === 'staging' ? 'staging-mobile-indicator' : undefined}>{identity.channel === 'staging' ? 'STAGING' : identity.shortLabel ?? identity.label}</span></header>
        <main id="workspace" tabIndex={-1}><ComposedRoutes visible={visible} /></main>
      </div>
    </div>
  );
}

function coreRouteElement(surface: CoreSurfaceManifest, visible: VisibleWebComposition) {
  switch (surface.id) {
    case 'content': return <ContentPage />;
    case 'import': return <ImportPage />;
    case 'tags': return <TagsPage />;
    case 'libraries': return <LibrariesPage />;
    case 'library-answers': return <AnswersPage />;
    case 'library-members':
    case 'library-overview':
    case 'library-recipes':
    case 'library-reports':
    case 'library-dashboards':
    case 'library-audit': return <LibraryPage />;
    case 'answers': return <AnswersPage />;
    case 'batch-jobs': return <BatchJobsPage />;
    case 'settings': return <SettingsPage extensionSections={visible.settings} />;
    default: throw new Error(`Core route ${surface.id} has no OSS page implementation`);
  }
}

function ComposedRoutes({ visible }: { visible: VisibleWebComposition }) {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/content" replace />} />
      {coreRouteManifest.map((surface) => (
        <Route key={surface.id} path={surface.path} element={coreRouteElement(surface, visible)} />
      ))}
      {visible.routes.map((route) => <Route key={route.id} path={route.path} element={route.element} />)}
      <Route path="*" element={<Navigate to="/content" replace />} />
    </Routes>
  );
}

export function App({ extensions }: { readonly extensions?: WebAppExtensions } = {}) {
  const composition = useMemo(() => createWebComposition(extensions), [extensions]);
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: 1, staleTime: 15_000 } },
  }));
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <LocalSessionGate composition={composition} />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
