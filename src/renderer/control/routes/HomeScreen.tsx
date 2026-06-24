import { useEffect, useMemo, useState } from 'react';
import type { ProjectSummary, ProjectPlanState } from '@shared/domain';
import type { Navigator, Route } from '../app';
import { Button } from '../components/Button';
import { StatusPill, type StatusTone } from '../components/StatusPill';
import { ListRow } from '../components/ListRow';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { describeError } from '../lib/errors';
import { formatRelative } from '../lib/format';
import route from './route.module.css';
import styles from './HomeScreen.module.css';

interface HomeScreenProps {
  nav: Navigator;
}

const DEFAULT_CHARACTER_ID = 'mira';

const PLAN_PILL: Record<ProjectPlanState, { tone: StatusTone; text: string }> = {
  ready: { tone: 'success', text: 'Ready to interview' },
  stale: { tone: 'warning', text: 'Needs an update' },
  preparing: { tone: 'accent', text: 'Preparing' },
  failed: { tone: 'danger', text: 'Preparation failed' },
  unprepared: { tone: 'neutral', text: 'Draft' },
};

/** The context-sensitive action for an interview, based on its readiness. */
function actionFor(project: ProjectSummary, nav: Navigator): { label: string; run: () => void } {
  switch (project.planState) {
    case 'ready':
      return { label: 'Start', run: () => nav.go({ name: 'preflight', projectId: project.id }) };
    case 'stale':
      return { label: 'Update', run: () => nav.go({ name: 'project', projectId: project.id }) };
    case 'failed':
      return { label: 'Fix', run: () => nav.go({ name: 'project', projectId: project.id }) };
    default:
      return { label: 'Continue', run: () => nav.go({ name: 'project', projectId: project.id }) };
  }
}

function metaFor(project: ProjectSummary): string {
  const parts = [`Updated ${formatRelative(project.updatedAt)}`];
  if (project.sessionCount > 0) {
    parts.push(`${project.sessionCount} session${project.sessionCount === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

export function HomeScreen({ nav }: HomeScreenProps): JSX.Element {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [miraImage, setMiraImage] = useState<string | null>(null);
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
    window.candidcue.characters
      .list()
      .then((list) => {
        if (cancelled) {
          return;
        }
        const mira = list.find((character) => character.id === DEFAULT_CHARACTER_ID) ?? list[0];
        setMiraImage(mira?.profileImageUrl ?? null);
      })
      .catch(() => {
        /* the empty-state portrait is a nicety; ignore load failures */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const newInterview = (): void => nav.go({ name: 'project', projectId: null });

  // Most-recently-touched first: the top one is featured as "continue".
  const sorted = useMemo(() => {
    if (projects === null) {
      return null;
    }
    return [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [projects]);

  const featured = sorted && sorted.length > 0 ? sorted[0] : null;
  const rest = sorted ? sorted.slice(1) : [];

  return (
    <>
      <PageHeader
        title="Interviews"
        actions={
          <Button variant="primary" onClick={newInterview}>
            <Icon name="plus" size={16} /> New interview
          </Button>
        }
      />
      <div className={route.page}>
        {error !== null && (
          <p className={route.error} role="alert">
            {error}
          </p>
        )}

        {sorted === null ? (
          <p className={route.empty}>Loading interviews…</p>
        ) : sorted.length === 0 ? (
          <EmptyState miraImage={miraImage} onCreate={newInterview} />
        ) : (
          <>
            {featured && <FeaturedInterview project={featured} nav={nav} miraImage={miraImage} />}

            {rest.length > 0 && (
              <section className={styles.recent}>
                <h2 className={styles.recentTitle}>Recent interviews</h2>
                <ul className={styles.list}>
                  {rest.map((project) => {
                    const pill = PLAN_PILL[project.planState];
                    const action = actionFor(project, nav);
                    const title = project.title.trim() === '' ? 'Untitled interview' : project.title;
                    return (
                      <li key={project.id}>
                        <ListRow
                          title={title}
                          meta={metaFor(project)}
                          onOpen={() => nav.go({ name: 'project', projectId: project.id })}
                          ariaLabel={`Open ${title}`}
                          status={<StatusPill tone={pill.tone}>{pill.text}</StatusPill>}
                          action={
                            <Button variant="secondary" onClick={action.run}>
                              {action.label}
                            </Button>
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}

function FeaturedInterview({
  project,
  nav,
  miraImage,
}: {
  project: ProjectSummary;
  nav: Navigator;
  miraImage: string | null;
}): JSX.Element {
  const pill = PLAN_PILL[project.planState];
  const action = actionFor(project, nav);
  const title = project.title.trim() === '' ? 'Untitled interview' : project.title;
  const open: Route = { name: 'project', projectId: project.id };
  return (
    <section className={styles.featured}>
      <span className={styles.featuredLabel}>Continue where you left off</span>
      <div className={styles.featuredBody}>
        {miraImage !== null && <img className={styles.featuredPortrait} src={miraImage} alt="" aria-hidden />}
        <button type="button" className={styles.featuredMain} onClick={() => nav.go(open)}>
          <span className={styles.featuredTitle}>{title}</span>
          <span className={styles.featuredMeta}>
            <StatusPill tone={pill.tone}>{pill.text}</StatusPill>
            <span className={styles.featuredTime}>Updated {formatRelative(project.updatedAt)}</span>
          </span>
        </button>
        <Button variant="primary" onClick={action.run}>
          {action.label}
        </Button>
      </div>
    </section>
  );
}

function EmptyState({ miraImage, onCreate }: { miraImage: string | null; onCreate: () => void }): JSX.Element {
  return (
    <div className={styles.emptyState}>
      <span className={styles.emptyPortrait} aria-hidden>
        {miraImage !== null ? <img src={miraImage} alt="" /> : <Icon name="sparkles" size={28} />}
      </span>
      <h2 className={styles.emptyTitle}>Start your first interview</h2>
      <p className={styles.emptyText}>Mira conducts a natural, guided conversation from material you provide.</p>
      <ol className={styles.emptySteps}>
        <li>
          <span className={styles.emptyStepNum}>1</span>
          Add the background material.
        </li>
        <li>
          <span className={styles.emptyStepNum}>2</span>
          Choose how the interview should feel.
        </li>
        <li>
          <span className={styles.emptyStepNum}>3</span>
          Start a guided conversation.
        </li>
      </ol>
      <Button variant="primary" onClick={onCreate}>
        <Icon name="plus" size={16} /> New interview
      </Button>
    </div>
  );
}
