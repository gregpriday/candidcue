import { useEffect, useState } from 'react';
import type { ProjectSummary } from '@shared/domain';
import type { Navigator } from '../app';
import { Button } from '../components/Button';
import { StatusIcon } from '../components/StatusIcon';
import { describeError } from '../lib/errors';
import { formatTimestamp } from '../lib/format';
import route from './route.module.css';
import styles from './HomeScreen.module.css';

interface HomeScreenProps {
  nav: Navigator;
}

export function HomeScreen({ nav }: HomeScreenProps): JSX.Element {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    window.candidcue.projects
      .list()
      .then((list) => {
        if (!cancelled) {
          setProjects(list);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(describeError(err));
          setProjects([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={route.page}>
      <div className={route.pageHeader}>
        <div>
          <h1 className={route.title}>Interview projects</h1>
          <p className={route.subtitle}>
            Each project holds the source material and goals that shape one interview.
          </p>
        </div>
        <div className={route.headerActions}>
          <Button variant="primary" onClick={() => nav.go({ name: 'project', projectId: null })}>
            New interview project
          </Button>
        </div>
      </div>

      {error !== null && (
        <p className={route.error} role="alert">
          {error}
        </p>
      )}

      {projects === null ? (
        <p className={route.empty}>Loading projects…</p>
      ) : projects.length === 0 ? (
        <div className={route.panel}>
          <div className={route.empty}>
            <p>You have no projects yet. Create one to prepare your first interview.</p>
            <Button variant="primary" onClick={() => nav.go({ name: 'project', projectId: null })}>
              New interview project
            </Button>
          </div>
        </div>
      ) : (
        <ul className={styles.grid}>
          {projects.map((project) => (
            <li key={project.id}>
              <ProjectCard project={project} nav={nav} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectCard({ project, nav }: { project: ProjectSummary; nav: Navigator }): JSX.Element {
  const prepared = project.status === 'prepared';
  const stale = project.status === 'stale';
  const badge = prepared
    ? { tone: 'success' as const, label: 'Prepared', text: 'Prepared' }
    : stale
      ? { tone: 'warning' as const, label: 'Needs re-preparation', text: 'Stale' }
      : { tone: 'pending' as const, label: 'Not prepared', text: 'Unprepared' };

  return (
    <button
      type="button"
      className={styles.card}
      onClick={() => nav.go({ name: 'project', projectId: project.id })}
    >
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>{project.title || 'Untitled project'}</span>
        <span className={styles.badge}>
          <StatusIcon tone={badge.tone} label={badge.label} />
          {badge.text}
        </span>
      </div>
      <dl className={styles.meta}>
        <div className={styles.metaItem}>
          <dt>Sessions</dt>
          <dd>{project.sessionCount}</dd>
        </div>
        <div className={styles.metaItem}>
          <dt>Last session</dt>
          <dd>{formatTimestamp(project.lastSessionAt)}</dd>
        </div>
        <div className={styles.metaItem}>
          <dt>Updated</dt>
          <dd>{formatTimestamp(project.updatedAt)}</dd>
        </div>
      </dl>
    </button>
  );
}
