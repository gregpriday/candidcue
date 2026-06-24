import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ProjectAggregate,
  ProjectId,
  ProjectPlanState,
  SaveProjectInput,
  TargetMode,
  PublicCharacterSummary,
  InterviewSession,
} from '@shared/domain';
import {
  createSourceDrafts,
  sourceDraftsFromAggregate,
  sourceDraftsToSaveInput,
  type SourceDraft,
} from '@shared/project-source-draft';
import { canSaveSources, computeSourceLibraryStats } from '@shared/project-source-stats';
import { PROJECT_SOURCE_LIMITS } from '@shared/constants/project-source-limits';
import type { Navigator } from '../app';
import { Button } from '../components/Button';
import { StatusIcon } from '../components/StatusIcon';
import type { StatusTone } from '../components/StatusIcon';
import { PageHeader } from '../components/PageHeader';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { SourceLibrary } from '../components/SourceLibrary';
import { nextDraftKey } from '../lib/draft-key';
import { describeError } from '../lib/errors';
import { formatTimestamp } from '../lib/format';
import route from './route.module.css';
import styles from './ProjectEditor.module.css';

interface ProjectEditorProps {
  nav: Navigator;
  projectId: ProjectId | null;
}

interface FormState {
  title: string;
  audience: string;
  intendedOutcome: string;
  targetMode: TargetMode;
  targetValue: number;
  notesToInterviewer: string;
  interviewerCharacterId: string;
  sources: SourceDraft[];
}

const DEFAULT_CHARACTER_ID = 'mira';
type ProjectTab = 'overview' | 'sources' | 'sessions';

function emptyForm(characterId: string): FormState {
  return {
    title: '',
    audience: '',
    intendedOutcome: '',
    targetMode: 'question_count',
    targetValue: 12,
    notesToInterviewer: '',
    interviewerCharacterId: characterId,
    sources: createSourceDrafts(nextDraftKey),
  };
}

function aggregateToForm(aggregate: ProjectAggregate): FormState {
  const project = aggregate.project;
  return {
    title: project.title,
    audience: project.audience ?? '',
    intendedOutcome: project.intendedOutcome ?? '',
    targetMode: project.targetMode,
    targetValue: project.targetValue,
    notesToInterviewer: project.notesToInterviewer ?? '',
    interviewerCharacterId: project.interviewerCharacterId,
    sources: sourceDraftsFromAggregate(aggregate, nextDraftKey),
  };
}

/** Renderer-side label/tone for each plan readiness state. */
const PLAN_BADGE: Record<ProjectPlanState, { tone: StatusTone; label: string }> = {
  unprepared: { tone: 'pending', label: 'Draft' },
  preparing: { tone: 'active', label: 'Preparing…' },
  ready: { tone: 'success', label: 'Ready' },
  stale: { tone: 'warning', label: 'Sources changed' },
  failed: { tone: 'danger', label: 'Preparation failed' },
};

function sessionStatus(status: InterviewSession['status']): { tone: StatusTone; label: string } {
  switch (status) {
    case 'completed':
      return { tone: 'success', label: 'Completed' };
    case 'active':
      return { tone: 'active', label: 'Live' };
    case 'paused':
      return { tone: 'warning', label: 'Paused' };
    case 'recovering':
      return { tone: 'warning', label: 'Recovering' };
    case 'abandoned':
      return { tone: 'danger', label: 'Abandoned' };
    case 'ready':
      return { tone: 'pending', label: 'Ready' };
    case 'preflight':
    default:
      return { tone: 'neutral', label: 'Preflight' };
  }
}

function formatDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt) {
    return 'Not started';
  }
  if (!endedAt) {
    return 'In progress';
  }
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) {
    return 'Duration unavailable';
  }
  const minutes = Math.max(1, Math.round((ended - started) / 60_000));
  return `${minutes} min`;
}

export function ProjectEditor({ nav, projectId }: ProjectEditorProps): JSX.Element {
  const [form, setForm] = useState<FormState | null>(null);
  const [savedId, setSavedId] = useState<ProjectId | null>(projectId);
  const [characters, setCharacters] = useState<PublicCharacterSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [planState, setPlanState] = useState<ProjectPlanState>('unprepared');
  const [dirty, setDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ProjectTab>('overview');
  const [sessionHistory, setSessionHistory] = useState<InterviewSession[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.candidcue.characters
      .list()
      .then((list) => {
        if (!cancelled) {
          setCharacters(list);
        }
      })
      .catch(() => {
        /* character list is non-fatal; selection falls back to default id */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setDirty(false);
    setLastSavedAt(null);
    setActiveTab('overview');
    setSessionHistory(null);
    setSessionsError(null);
    if (projectId === null) {
      setForm(emptyForm(DEFAULT_CHARACTER_ID));
      setPlanState('unprepared');
      return;
    }
    window.candidcue.projects
      .get(projectId)
      .then((aggregate) => {
        if (cancelled) {
          return;
        }
        if (aggregate === null) {
          setLoadError('This project could not be found.');
          setForm(emptyForm(DEFAULT_CHARACTER_ID));
          return;
        }
        setForm(aggregateToForm(aggregate));
        setPlanState(aggregate.planState);
        setLastSavedAt(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(describeError(err));
          setForm(emptyForm(DEFAULT_CHARACTER_ID));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const patch = useCallback((partial: Partial<FormState>) => {
    setForm((prev) => (prev ? { ...prev, ...partial } : prev));
    setDirty(true);
  }, []);

  const setSources = useCallback((sources: SourceDraft[]) => {
    setForm((prev) => (prev ? { ...prev, sources } : prev));
    setDirty(true);
  }, []);

  const buildInput = useCallback((state: FormState, id: ProjectId | null): SaveProjectInput => {
    const input: SaveProjectInput = {
      title: state.title.trim() || 'Untitled project',
      audience: state.audience.trim() ? state.audience.trim() : null,
      intendedOutcome: state.intendedOutcome.trim() ? state.intendedOutcome.trim() : null,
      targetMode: state.targetMode,
      targetValue: state.targetValue,
      interviewerCharacterId: state.interviewerCharacterId,
      notesToInterviewer: state.notesToInterviewer.trim() ? state.notesToInterviewer.trim() : null,
      documents: sourceDraftsToSaveInput(state.sources),
    };
    return id ? { ...input, id } : input;
  }, []);

  const handleSave = useCallback(async (): Promise<ProjectId | null> => {
    if (!form) {
      return null;
    }
    setSaving(true);
    setActionError(null);
    try {
      const aggregate = await window.candidcue.projects.save(buildInput(form, savedId));
      setSavedId(aggregate.project.id);
      setForm(aggregateToForm(aggregate));
      setPlanState(aggregate.planState);
      setDirty(false);
      setLastSavedAt(new Date().toISOString());
      return aggregate.project.id;
    } catch (err: unknown) {
      setActionError(describeError(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, [form, savedId, buildInput]);

  const handlePrepare = useCallback(async () => {
    setActionError(null);
    setWarnings(null);
    const id = await handleSave();
    if (id === null) {
      return;
    }
    setPreparing(true);
    try {
      const result = await window.candidcue.projects.prepare(id);
      setWarnings(result.warnings);
      if (result.ok) {
        setPlanState('ready');
      } else {
        setPlanState('failed');
        if (result.error) {
          setActionError(result.error.publicMessage);
        }
      }
    } catch (err: unknown) {
      setActionError(describeError(err));
    } finally {
      setPreparing(false);
    }
  }, [handleSave]);

  useEffect(() => {
    if (!form || !dirty || saving || preparing) {
      return undefined;
    }
    const stats = computeSourceLibraryStats(form.sources);
    if (!canSaveSources(stats)) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void handleSave();
    }, 900);
    return () => window.clearTimeout(timer);
  }, [dirty, form, handleSave, preparing, saving]);

  useEffect(() => {
    if (activeTab !== 'sessions' || !savedId) {
      return undefined;
    }
    let cancelled = false;
    setSessionHistory(null);
    setSessionsError(null);
    window.candidcue.sessions
      .list(savedId)
      .then((sessions) => {
        if (!cancelled) {
          setSessionHistory(sessions);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSessionsError(describeError(err));
          setSessionHistory([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, savedId]);

  const requestBack = useCallback(() => {
    if (dirty) {
      setConfirmDiscard(true);
    } else {
      nav.go({ name: 'home' });
    }
  }, [dirty, nav]);

  const selectedCharacter = useMemo<PublicCharacterSummary | null>(() => {
    if (!form) {
      return null;
    }
    return characters.find((c) => c.id === form.interviewerCharacterId) ?? null;
  }, [characters, form]);

  const sourceStats = useMemo(
    () => (form ? computeSourceLibraryStats(form.sources) : null),
    [form],
  );

  if (!form || !sourceStats) {
    return (
      <>
        <PageHeader
          title={savedId ? 'Edit project' : 'New project'}
          onBack={() => nav.go({ name: 'home' })}
        />
        <div className={route.page}>
          <p className={route.empty}>{loadError ?? 'Loading project…'}</p>
        </div>
      </>
    );
  }

  const canSave = canSaveSources(sourceStats);
  const readyToStart = planState === 'ready' && !dirty;
  const badge = PLAN_BADGE[planState];
  const saveStatus = actionError
    ? 'Save error'
    : saving
      ? 'Saving…'
      : dirty
        ? 'Unsaved changes'
        : lastSavedAt
          ? 'Saved just now'
          : savedId
            ? 'Saved'
            : 'Not saved yet';
  // What blocks Prepare, in priority order, surfaced as an inline hint.
  const prepareBlocker = !canSave
    ? sourceStats.blockers[0]?.message ?? 'Resolve source issues before preparing.'
    : sourceStats.primaryEmpty
      ? 'Add content to the primary source before preparing.'
      : null;
  const shouldStart = readyToStart && savedId !== null;
  const primaryLabel = shouldStart
    ? 'Start interview'
    : preparing || planState === 'preparing'
      ? 'Preparing…'
      : planState === 'failed'
        ? 'Retry preparation'
        : planState === 'ready' || planState === 'stale' || dirty
          ? 'Update interview'
          : 'Prepare interview';
  const primaryDisabled = shouldStart
    ? false
    : preparing || saving || prepareBlocker !== null || planState === 'preparing';
  const runPrimaryAction = (): void => {
    if (shouldStart) {
      nav.go({ name: 'preflight', projectId: savedId });
      return;
    }
    void handlePrepare();
  };

  return (
    <>
      <PageHeader
        title={form.title.trim() || (savedId ? 'Untitled project' : 'New project')}
        meta={
          <span className={styles.headerMeta}>
            <span className={styles.preparedBadge}>
              <StatusIcon tone={badge.tone} label={badge.label} /> {badge.label}
            </span>
            <span>{saveStatus}</span>
          </span>
        }
        onBack={requestBack}
        actions={
          <Button
            variant="primary"
            onClick={runPrimaryAction}
            disabled={primaryDisabled}
            title={prepareBlocker ?? (shouldStart ? 'Start a session' : 'Prepare the interview from these sources')}
          >
            {primaryLabel}
          </Button>
        }
      />
      <div className={`${route.page} ${route.pageWide}`}>
        {confirmDiscard && (
          <div className={route.notice} role="alertdialog" aria-label="Discard unsaved changes">
            <StatusIcon tone="warning" label="Unsaved changes" />
            <div className={styles.confirmRow}>
              <span>You have unsaved changes. Leave without saving?</span>
              <span className={styles.confirmActions}>
                <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
                  Keep editing
                </Button>
                <Button variant="danger" onClick={() => nav.go({ name: 'home' })}>
                  Discard changes
                </Button>
              </span>
            </div>
          </div>
        )}

        {loadError !== null && (
          <p className={route.error} role="alert">
            {loadError}
          </p>
        )}
        {actionError !== null && (
          <p className={route.error} role="alert">
            {actionError}
          </p>
        )}

        {warnings !== null && (
          <div className={route.notice} role="status">
            <StatusIcon
              tone={warnings.length > 0 ? 'warning' : 'success'}
              label="Preparation result"
            />
            <div>
              {warnings.length === 0 ? (
                <span>Interview prepared with no warnings.</span>
              ) : (
                <>
                  <strong>Prepared with {warnings.length} warning(s):</strong>
                  <ul className={styles.warningList}>
                    {warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        )}

        <div className={styles.tabs} role="tablist" aria-label="Project sections">
          {(['overview', 'sources', 'sessions'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={`${styles.tab} ${activeTab === tab ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'overview' ? 'Overview' : tab === 'sources' ? 'Sources' : 'Sessions'}
            </button>
          ))}
        </div>

        {activeTab === 'overview' && (
          <div className={styles.overviewGrid}>
            <div className={styles.overviewMain}>
              <section className={styles.section}>
                <div className={styles.sectionHeader}>
                  <h2>Project brief</h2>
                  <p>Define what Mira should understand before the interview starts.</p>
                </div>
                <div className={route.field}>
                  <label className={route.label} htmlFor="project-title">
                    Project title
                  </label>
                  <input
                    id="project-title"
                    className={route.input}
                    value={form.title}
                    onChange={(e) => patch({ title: e.target.value })}
                    placeholder="e.g. The founding story of Acme Robotics"
                  />
                </div>

                <div className={route.row}>
                  <div className={`${route.field} ${route.rowItem}`}>
                    <label className={route.label} htmlFor="project-audience">
                      Intended audience
                    </label>
                    <input
                      id="project-audience"
                      className={route.input}
                      value={form.audience}
                      onChange={(e) => patch({ audience: e.target.value })}
                      placeholder="e.g. Prospective customers and press"
                    />
                  </div>
                  <div className={`${route.field} ${route.rowItem}`}>
                    <label className={route.label} htmlFor="project-outcome">
                      Desired outcome
                    </label>
                    <input
                      id="project-outcome"
                      className={route.input}
                      value={form.intendedOutcome}
                      onChange={(e) => patch({ intendedOutcome: e.target.value })}
                      placeholder="e.g. A candid narrative of the pivot"
                    />
                  </div>
                </div>
              </section>

              <section className={styles.section}>
                <div className={styles.sectionHeader}>
                  <h2>Interview length</h2>
                  <p>Choose whether the interview should land on a number of questions or an approximate duration.</p>
                </div>
                <div className={styles.lengthControl}>
                  <button
                    type="button"
                    className={`${styles.lengthOption} ${form.targetMode === 'question_count' ? styles.lengthOptionActive : ''}`}
                    onClick={() => patch({ targetMode: 'question_count' })}
                  >
                    <span>Questions</span>
                    <strong>{form.targetMode === 'question_count' ? form.targetValue : 12}</strong>
                  </button>
                  <button
                    type="button"
                    className={`${styles.lengthOption} ${form.targetMode === 'approximate_duration' ? styles.lengthOptionActive : ''}`}
                    onClick={() => patch({ targetMode: 'approximate_duration' })}
                  >
                    <span>Duration</span>
                    <strong>{form.targetMode === 'approximate_duration' ? `${form.targetValue} min` : '20 min'}</strong>
                  </button>
                  <div className={styles.lengthValue}>
                    <label className={route.label} htmlFor="project-target-value">
                      {form.targetMode === 'question_count' ? 'Number of questions' : 'Approximate duration'}
                    </label>
                    <input
                      id="project-target-value"
                      className={route.input}
                      type="number"
                      min={1}
                      value={form.targetValue}
                      onChange={(e) => {
                        const parsed = Number.parseInt(e.target.value, 10);
                        patch({ targetValue: Number.isFinite(parsed) && parsed > 0 ? parsed : 1 });
                      }}
                    />
                  </div>
                </div>
              </section>

              <section className={styles.section}>
                <div className={styles.sectionHeader}>
                  <h2>Interviewer</h2>
                  <p>Mira conducts the interview using your source material.</p>
                </div>
                <div className={styles.characterCard}>
                  {selectedCharacter && (
                    <img
                      className={styles.characterImage}
                      src={selectedCharacter.profileImageUrl}
                      alt={`Portrait of ${selectedCharacter.displayName}`}
                    />
                  )}
                  <div className={styles.characterBody}>
                    <div className={styles.characterName}>
                      {selectedCharacter?.displayName ?? form.interviewerCharacterId}
                    </div>
                    <div className={styles.characterDesc}>
                      {selectedCharacter?.shortDescription ?? 'Interview character'}
                    </div>
                  </div>
                  <label className={styles.characterSelectLabel} htmlFor="project-character">
                    Change interviewer
                  </label>
                  <select
                    id="project-character"
                    className={styles.characterSelect}
                    value={form.interviewerCharacterId}
                    onChange={(e) => patch({ interviewerCharacterId: e.target.value })}
                  >
                    {characters.length === 0 && (
                      <option value={form.interviewerCharacterId}>{form.interviewerCharacterId}</option>
                    )}
                    {characters.map((character) => (
                      <option key={character.id} value={character.id}>
                        {character.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              </section>

              <section className={styles.section}>
                <div className={styles.sectionHeader}>
                  <h2>Interviewer guidance</h2>
                  <p>Tone, subjects to explore, and areas to avoid.</p>
                </div>
                <MarkdownEditor
                  value={form.notesToInterviewer}
                  onChange={(value) => patch({ notesToInterviewer: value })}
                  ariaLabel="Interviewer guidance"
                  minHeight="180px"
                  placeholder="Keep the tone warm but probing. Avoid leading questions about funding."
                />
              </section>
            </div>

            <aside className={styles.readinessRail}>
              <section className={styles.readinessCard}>
                <div className={styles.sectionHeader}>
                  <h2>Preparation readiness</h2>
                  <p>{prepareBlocker ?? 'Sources are ready to prepare.'}</p>
                </div>
                <div className={styles.readinessStatus}>
                  <StatusIcon tone={badge.tone} label={badge.label} />
                  <span>{badge.label}</span>
                </div>
                <dl className={styles.readinessFacts}>
                  <div>
                    <dt>Sources</dt>
                    <dd>
                      {sourceStats.documentCount} of {PROJECT_SOURCE_LIMITS.maxDocuments}
                    </dd>
                  </div>
                  <div>
                    <dt>Characters</dt>
                    <dd>{sourceStats.totalCharacters.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Primary source</dt>
                    <dd>{sourceStats.primaryEmpty ? 'Needs content' : 'Ready'}</dd>
                  </div>
                </dl>
                {sourceStats.blockers.length > 0 && (
                  <ul className={styles.blockerList}>
                    {sourceStats.blockers.map((blocker) => (
                      <li key={blocker.code}>{blocker.message}</li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>
          </div>
        )}

        {activeTab === 'sources' && (
          <SourceLibrary
            drafts={form.sources}
            onChange={setSources}
            onImportError={setActionError}
          />
        )}

        {activeTab === 'sessions' && (
          <section className={styles.sessionsSection}>
            {sessionsError !== null && (
              <p className={route.error} role="alert">
                {sessionsError}
              </p>
            )}
            {!savedId ? (
              <p className={route.empty}>Save this project before running interview sessions.</p>
            ) : sessionHistory === null ? (
              <p className={route.empty}>Loading sessions…</p>
            ) : sessionHistory.length === 0 ? (
              <p className={route.empty}>No interview sessions yet. Prepare the project, then start an interview.</p>
            ) : (
              <ul className={styles.sessionList}>
                {sessionHistory.map((session) => {
                  const status = sessionStatus(session.status);
                  return (
                    <li key={session.id} className={styles.sessionRow}>
                      <div className={styles.sessionDate}>
                        <strong>{formatTimestamp(session.startedAt ?? session.createdAt)}</strong>
                        <span>{formatDuration(session.startedAt, session.endedAt)}</span>
                      </div>
                      <span className={styles.sessionBadge}>
                        <StatusIcon tone={status.tone} label={status.label} />
                        {status.label}
                      </span>
                      <span className={styles.sessionTurns}>{session.currentTurnOrdinal} turns</span>
                      <Button variant="ghost" onClick={() => nav.go({ name: 'review', sessionId: session.id })}>
                        Review
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>
    </>
  );
}
