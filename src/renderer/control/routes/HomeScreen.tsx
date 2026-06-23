import { useEffect, useState } from 'react';
import type { ProjectSummary, ProjectPlanState } from '@shared/domain';
import type { Navigator } from '../app';
import { Button } from '../components/Button';
import { StatusIcon, type StatusTone } from '../components/StatusIcon';
import { Icon } from '../components/Icon';
import { WorkspaceToolbar } from '../components/WorkspaceToolbar';
import { describeError } from '../lib/errors';
import { formatTimestamp } from '../lib/format';
import route from './route.module.css';
import styles from './HomeScreen.module.css';

interface HomeScreenProps {
  nav: Navigator;
}

/** Surface the richer plan lifecycle state on each tile (PROJ-01/02). */
const PLAN_BADGE: Record<ProjectPlanState, { tone: StatusTone; text: string }> = {
  ready: { tone: 'success', text: 'Ready' },
  stale: { tone: 'warning', text: 'Sources changed' },
  preparing: { tone: 'active', text: 'Preparing' },
  failed: { tone: 'danger', text: 'Preparation failed' },
  unprepared: { tone: 'pending', text: 'Draft' },
};

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

  const newProject = (): void => nav.go({ name: 'project', projectId: null });

  return (
    <>
      <WorkspaceToolbar
        title="Projects"
        meta="Prepare and run guided interviews."
        actions={
          <Button variant="primary" onClick={newProject}>
            <Icon name="plus" size={14} /> New project
          </Button>
        }
      />
      <div className={route.page}>
        {error !== null && (
          <p className={route.error} role="alert">
            {error}
          </p>
        )}

        {projects === null ? (
          <p className={route.empty}>Loading projects…</p>
        ) : projects.length === 0 ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyMark} aria-hidden>
              <Icon name="waveform" size={24} />
            </span>
            <h2 className={styles.emptyTitle}>Your interview workspace</h2>
            <p className={styles.emptyText}>
              Prepare projects with source material and context, then conduct natural interviews.
            </p>
            <p className={styles.emptyHint}>
              Create your first project to begin.
            </p>
            <Button variant="primary" onClick={newProject}>
              <Icon name="plus" size={14} /> New project
            </Button>
          </div>
        ) : (
          <ul className={styles.grid}>
            {projects.map((project) => (
              <li key={project.id}>
                <ProjectCard project={project} nav={nav} />
              </li>
            ))}
            <li>
              <button type="button" className={styles.createCard} onClick={newProject}>
                <span className={styles.createIcon}>
                  <Icon name="plus" size={18} />
                </span>
                <span>
                  <span className={styles.createTitle}>Create new project</span>
                  <span className={styles.createText}>Start a guided interview workspace.</span>
                </span>
              </button>
            </li>
          </ul>
        )}
      </div>
    </>
  );
}

function ProjectCard({ project, nav }: { project: ProjectSummary; nav: Navigator }): JSX.Element {
  const badge = PLAN_BADGE[project.planState] ?? PLAN_BADGE.unprepared;
  return (
    <button
      type="button"
      className={styles.card}
      onClick={() => nav.go({ name: 'project', projectId: project.id })}
    >
      <span className={styles.cardHeader}>
        <span className={styles.cardTitle}>{project.title || 'Untitled project'}</span>
        <span className={styles.badge}>
          <StatusIcon tone={badge.tone} label={badge.text} size={12} />
          {badge.text}
        </span>
      </span>
      <span className={styles.nextAction}>
        {project.planState === 'ready'
          ? 'Start interview'
          : project.planState === 'stale'
            ? 'Update interview'
            : 'Continue setup'}
      </span>
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
