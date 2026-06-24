import { useEffect, useState } from 'react';
import type { ProjectSummary } from '@shared/domain';
import type { PublicAppError } from '@shared/errors/app-error';
import type { Navigator, Route } from '../app';
import { Icon, type IconName } from './Icon';
import { StatusIcon } from './StatusIcon';
import styles from './AppSidebar.module.css';

interface NavLink {
  label: string;
  icon: IconName;
  route: Route;
  matches: (route: Route) => boolean;
}

const IS_DEV = import.meta.env.DEV;

/**
 * The workspace's quiet left navigation. Slightly recessed from the content so
 * the main area dominates. Holds the brand, the one creative action, primary
 * destinations, and a recent-interviews shortcut list.
 */
export function AppSidebar({
  nav,
  route,
  lastError,
}: {
  nav: Navigator;
  route: Route;
  lastError: PublicAppError | null;
}): JSX.Element {
  const [recent, setRecent] = useState<ProjectSummary[]>([]);

  // Best-effort recent list; refreshes whenever the route changes (e.g. after
  // creating or editing an interview and returning).
  useEffect(() => {
    let active = true;
    window.candidcue.projects
      .list()
      .then((list) => {
        if (active) {
          setRecent(list.slice(0, 6));
        }
      })
      .catch(() => {
        /* recent list is a convenience; ignore load failures */
      });
    return () => {
      active = false;
    };
  }, [route]);

  const links: NavLink[] = [
    { label: 'Interviews', icon: 'library', route: { name: 'home' }, matches: (r) => r.name === 'home' },
    { label: 'Settings', icon: 'settings', route: { name: 'settings' }, matches: (r) => r.name === 'settings' },
    ...(IS_DEV
      ? [
          {
            label: 'Design Lab',
            icon: 'sparkles' as IconName,
            route: { name: 'designlab' } as Route,
            matches: (r: Route) => r.name === 'designlab',
          },
        ]
      : []),
  ];

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brandRow}>
        <span className={styles.brandTile} aria-hidden>
          <Icon name="waveform" size={15} />
        </span>
        <span className={styles.brand}>CandidCue</span>
      </div>

      <button
        type="button"
        className={styles.newButton}
        onClick={() => nav.go({ name: 'project', projectId: null })}
      >
        <Icon name="plus" size={16} />
        New interview
      </button>

      <nav className={styles.nav} aria-label="Primary">
        {links.map((link) => (
          <button
            key={link.label}
            type="button"
            className={[styles.navItem, link.matches(route) ? styles.navItemActive : null].filter(Boolean).join(' ')}
            onClick={() => nav.go(link.route)}
            aria-current={link.matches(route) ? 'page' : undefined}
          >
            <Icon name={link.icon} size={18} />
            <span>{link.label}</span>
          </button>
        ))}
      </nav>

      {recent.length > 0 && (
        <div className={styles.recent}>
          <span className={styles.recentLabel}>Recent</span>
          <ul className={styles.recentList}>
            {recent.map((project) => {
              const active = route.name === 'project' && route.projectId === project.id;
              const title = project.title.trim() === '' ? 'Untitled interview' : project.title;
              return (
                <li key={project.id}>
                  <button
                    type="button"
                    className={[styles.recentItem, active ? styles.recentItemActive : null]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => nav.go({ name: 'project', projectId: project.id })}
                    title={title}
                  >
                    {title}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className={styles.footer}>
        {lastError && (
          <div className={styles.issue} title={`Attention: ${lastError.publicMessage}`}>
            <StatusIcon tone="danger" label="Attention" size={14} />
            <span className={styles.issueText}>{lastError.publicMessage}</span>
          </div>
        )}
      </div>
    </aside>
  );
}
