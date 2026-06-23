import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectId } from '@shared/domain';
import type { PublicAppError } from '@shared/errors/app-error';
import { HomeScreen } from './routes/HomeScreen';
import { ProjectEditor } from './routes/ProjectEditor';
import { SettingsScreen } from './routes/SettingsScreen';
import { PreflightScreen } from './routes/PreflightScreen';
import { OperatorConsole } from './routes/OperatorConsole';
import { ReviewScreen } from './routes/ReviewScreen';
import { StatusIcon, type StatusTone } from './components/StatusIcon';
import styles from './app.module.css';

export type Route =
  | { name: 'home' }
  | { name: 'project'; projectId: ProjectId | null }
  | { name: 'settings' }
  | { name: 'preflight'; projectId: ProjectId }
  | { name: 'operator'; sessionId: string }
  | { name: 'review'; sessionId: string };

export interface Navigator {
  go: (route: Route) => void;
}

interface NavItem {
  label: string;
  route: Route;
  matches: (route: Route) => boolean;
}

export function App(): JSX.Element {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [lastError, setLastError] = useState<PublicAppError | null>(null);

  const go = useCallback((next: Route) => {
    setRoute(next);
  }, []);

  const nav = useMemo<Navigator>(() => ({ go }), [go]);

  useEffect(() => {
    const unsubscribe = window.candidcue.events.onError((error) => {
      setLastError(error);
    });
    return unsubscribe;
  }, []);

  const navItems: NavItem[] = [
    { label: 'Projects', route: { name: 'home' }, matches: (r) => r.name === 'home' || r.name === 'project' },
    { label: 'Settings', route: { name: 'settings' }, matches: (r) => r.name === 'settings' },
  ];

  const statusTone: StatusTone = lastError ? 'danger' : 'success';
  const statusLabel = lastError
    ? `Attention: ${lastError.publicMessage}`
    : 'All systems nominal';

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.wordmark}>
          <span className={styles.mark}>Candid</span>
          <span className={styles.markAccent}>Cue</span>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.settingsLink}
            onClick={() => go({ name: 'settings' })}
            aria-current={route.name === 'settings' ? 'page' : undefined}
          >
            Settings
          </button>
          <div className={styles.diagnostics} title={statusLabel}>
            <StatusIcon tone={statusTone} label={statusLabel} />
            <span className={styles.diagnosticsText}>{lastError ? 'Issue' : 'Ready'}</span>
          </div>
        </div>
      </header>

      <div className={styles.body}>
        <nav className={styles.sidenav} aria-label="Primary">
          <ul className={styles.navList}>
            {navItems.map((item) => (
              <li key={item.label}>
                <button
                  type="button"
                  className={`${styles.navButton} ${item.matches(route) ? styles.navButtonActive : ''}`}
                  onClick={() => go(item.route)}
                  aria-current={item.matches(route) ? 'page' : undefined}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <main className={styles.main}>
          <RouteView route={route} nav={nav} />
        </main>
      </div>

      <div className={styles.statusBar} role="status" aria-live="polite">
        {lastError ? (
          <span className={styles.statusError}>
            <StatusIcon tone="danger" label="Error" /> {lastError.publicMessage}
          </span>
        ) : (
          <span className={styles.statusOk}>Ready</span>
        )}
      </div>
    </div>
  );
}

function RouteView({ route, nav }: { route: Route; nav: Navigator }): JSX.Element {
  switch (route.name) {
    case 'home':
      return <HomeScreen nav={nav} />;
    case 'project':
      return <ProjectEditor nav={nav} projectId={route.projectId} />;
    case 'settings':
      return <SettingsScreen />;
    case 'preflight':
      return <PreflightScreen nav={nav} projectId={route.projectId} />;
    case 'operator':
      return <OperatorConsole nav={nav} sessionId={route.sessionId} />;
    case 'review':
      return <ReviewScreen nav={nav} sessionId={route.sessionId} />;
    default:
      return <HomeScreen nav={nav} />;
  }
}
