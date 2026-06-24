import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectId } from '@shared/domain';
import type { PublicAppError } from '@shared/errors/app-error';
import { HomeScreen } from './routes/HomeScreen';
import { ProjectEditor } from './routes/ProjectEditor';
import { SettingsScreen } from './routes/SettingsScreen';
import { PreflightScreen } from './routes/PreflightScreen';
import { OperatorConsole } from './routes/OperatorConsole';
import { ReviewScreen } from './routes/ReviewScreen';
import { DesignLab } from './routes/DesignLab';
import { AppSidebar } from './components/AppSidebar';
import styles from './app.module.css';

export type Route =
  | { name: 'home' }
  | { name: 'project'; projectId: ProjectId | null }
  | { name: 'settings' }
  | { name: 'preflight'; projectId: ProjectId }
  | { name: 'operator'; sessionId: string }
  | { name: 'review'; sessionId: string }
  | { name: 'designlab' };

/** Dev-only surfaces (the design gallery) are gated out of production builds. */
const IS_DEV = import.meta.env.DEV;
const START_IN_LAB =
  IS_DEV &&
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('lab');

export interface Navigator {
  go: (route: Route) => void;
}

/** Stamp the OS onto the shell so the window-control gutter is reserved on the
 * correct side (traffic lights top-left on macOS, control overlay right
 * elsewhere). */
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);

export function App(): JSX.Element {
  const [route, setRoute] = useState<Route>(START_IN_LAB ? { name: 'designlab' } : { name: 'home' });
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

  // Two themes / two shells: the calm light workspace (sidebar + content) at
  // rest, and the focused dark studio — full-bleed, no sidebar — when a session
  // is live. The whole shell re-skins via the shared token names.
  const isLive = route.name === 'operator';
  const theme = isLive ? 'studio' : 'workspace';

  return (
    <div className={styles.shell} data-platform={IS_MAC ? 'mac' : 'other'} data-theme={theme}>
      {isLive ? (
        <main className={styles.studioMain}>
          <div className={styles.studioDrag} aria-hidden />
          <div className={styles.studioScroll}>
            <RouteView route={route} nav={nav} />
          </div>
        </main>
      ) : (
        <div className={styles.body}>
          <AppSidebar nav={nav} route={route} lastError={lastError} />
          <main className={styles.main}>
            <RouteView route={route} nav={nav} />
          </main>
        </div>
      )}
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
    case 'designlab':
      // Dev-only surface — never render it in a production build.
      return IS_DEV ? <DesignLab nav={nav} /> : <HomeScreen nav={nav} />;
    default:
      return <HomeScreen nav={nav} />;
  }
}
