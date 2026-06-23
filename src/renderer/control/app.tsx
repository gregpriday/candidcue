import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectId } from '@shared/domain';
import type { PublicAppError } from '@shared/errors/app-error';
import { HomeScreen } from './routes/HomeScreen';
import { ProjectEditor } from './routes/ProjectEditor';
import { SettingsScreen } from './routes/SettingsScreen';
import { PreflightScreen } from './routes/PreflightScreen';
import { OperatorConsole } from './routes/OperatorConsole';
import { ReviewScreen } from './routes/ReviewScreen';
import { StatusIcon } from './components/StatusIcon';
import { Icon } from './components/Icon';
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

/** Stamp the OS onto the shell so the title bar can reserve the native
 * window-control gutter on the correct side (traffic lights left on macOS,
 * control overlay right elsewhere). */
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);

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

  const primaryNav: NavItem[] = [
    {
      label: 'Projects',
      route: { name: 'home' },
      matches: (r) => r.name === 'home' || r.name === 'project' || r.name === 'preflight' || r.name === 'review',
    },
    { label: 'Settings', route: { name: 'settings' }, matches: (r) => r.name === 'settings' },
  ];

  const renderNav = (item: NavItem): JSX.Element => (
    <button
      key={item.label}
      type="button"
      className={`${styles.navButton} ${item.matches(route) ? styles.navButtonActive : ''}`}
      onClick={() => go(item.route)}
      aria-current={item.matches(route) ? 'page' : undefined}
    >
      {item.label}
    </button>
  );

  // Live mode: when in operator view, the entire UI transforms
  const isLive = route.name === 'operator';

  return (
    <div className={styles.shell} data-platform={IS_MAC ? 'mac' : 'other'} data-live={isLive ? 'true' : 'false'}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.wordmark}>
            <span className={styles.brandTile} aria-hidden>
              <Icon name="waveform" size={13} />
            </span>
            <span className={styles.mark}>Candid</span>
            <span className={styles.markAccent}>Cue</span>
          </span>
          <nav className={styles.titleNav} aria-label="Primary">
            {primaryNav.map(renderNav)}
          </nav>
        </div>
        {lastError && (
          <div className={styles.headerActions}>
            <div className={styles.diagnostics} title={`Attention: ${lastError.publicMessage}`}>
              <StatusIcon tone="danger" label={`Attention: ${lastError.publicMessage}`} />
              <span className={styles.diagnosticsText}>Issue</span>
            </div>
          </div>
        )}
      </header>

      <div className={styles.body}>
        <main className={styles.main}>
          <RouteView route={route} nav={nav} />
        </main>
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
