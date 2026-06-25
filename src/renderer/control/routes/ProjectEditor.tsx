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
import type { Navigator } from '../app';
import { Button } from '../components/Button';
import { StatusIcon, type StatusTone } from '../components/StatusIcon';
import { StatusPill, type StatusTone as PillTone } from '../components/StatusPill';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { Section } from '../components/Section';
import { SegmentedControl } from '../components/SegmentedControl';
import { ProgressSteps, type ProgressStep } from '../components/ProgressSteps';
import { Sheet } from '../components/Sheet';
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

type EditorStep = 'brief' | 'reference' | 'style' | 'ready';
const STEPS: ReadonlyArray<ProgressStep<EditorStep>> = [
  { key: 'brief', label: 'Brief' },
  { key: 'reference', label: 'Reference material' },
  { key: 'style', label: 'Interview style' },
  { key: 'ready', label: 'Ready' },
];

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
const PLAN_PILL: Record<ProjectPlanState, { tone: PillTone; label: string }> = {
  unprepared: { tone: 'neutral', label: 'Draft' },
  preparing: { tone: 'accent', label: 'Preparing…' },
  ready: { tone: 'success', label: 'Ready' },
  stale: { tone: 'warning', label: 'Needs an update' },
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
  // A momentary "Saved just now" pulse in the header right after an actual save;
  // the persistent quiet state ("All changes saved") lives only in the footer.
  const [justSaved, setJustSaved] = useState(false);
  // The footer's save confirmation is transient: it lingers for ~2s after a save,
  // then fades out over 160ms rather than sitting as a permanent idle label.
  const [savedConfirm, setSavedConfirm] = useState<'hidden' | 'visible' | 'fading'>('hidden');
  const [step, setStep] = useState<EditorStep>('brief');
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
    setJustSaved(false);
    setSavedConfirm('hidden');
    setStep('brief');
    setSessionHistory(null);
    setSessionsError(null);
    // Reset the persisted id and per-interview transient state — the sidebar can
    // navigate straight from one interview to another without unmounting, so a
    // stale savedId would let autosave write this form into the previous id.
    setSavedId(projectId);
    setWarnings(null);
    setActionError(null);
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
          setLoadError('This interview could not be found.');
          setForm(emptyForm(DEFAULT_CHARACTER_ID));
          return;
        }
        setForm(aggregateToForm(aggregate));
        setPlanState(aggregate.planState);
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
      title: state.title.trim() || 'Untitled interview',
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
      setJustSaved(true);
      setSavedConfirm('visible');
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

  // Let the header's "Saved just now" pulse fade back to quiet a moment after the
  // save lands, so the persistent confirmation reads only once in the footer.
  useEffect(() => {
    if (!justSaved) {
      return undefined;
    }
    const timer = window.setTimeout(() => setJustSaved(false), 2400);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  // Footer save confirmation: hold "All changes saved" ~2s, then fade over 160ms.
  useEffect(() => {
    if (savedConfirm === 'visible') {
      const timer = window.setTimeout(() => setSavedConfirm('fading'), 2000);
      return () => window.clearTimeout(timer);
    }
    if (savedConfirm === 'fading') {
      const timer = window.setTimeout(() => setSavedConfirm('hidden'), 160);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [savedConfirm]);

  // A fresh edit supersedes the lingering confirmation immediately — the footer
  // should read "Unsaved changes", not fade out a stale "All changes saved".
  useEffect(() => {
    if (dirty && savedConfirm !== 'hidden') {
      setSavedConfirm('hidden');
    }
  }, [dirty, savedConfirm]);

  useEffect(() => {
    if (step !== 'ready' || !savedId) {
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
  }, [step, savedId]);

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
        <PageHeader title={savedId ? 'Edit interview' : 'New interview'} onBack={() => nav.go({ name: 'home' })} />
        <div className={route.page}>
          <p className={route.empty}>{loadError ?? 'Loading interview…'}</p>
        </div>
      </>
    );
  }

  const canSave = canSaveSources(sourceStats);
  const pill = PLAN_PILL[planState];
  // The footer carries the save state, but only while it's worth saying: it shows
  // persistently while Saving / Unsaved / Failed, then — after a successful save —
  // confirms "All changes saved" for ~2s and fades out, leaving the bar quiet.
  let footerStatus: string | null;
  let footerStatusFading = false;
  if (actionError) {
    footerStatus = 'Save error';
  } else if (saving) {
    footerStatus = 'Saving…';
  } else if (dirty) {
    footerStatus = 'Unsaved changes';
  } else if (savedId === null) {
    footerStatus = 'Not saved yet';
  } else if (savedConfirm !== 'hidden') {
    footerStatus = 'All changes saved';
    footerStatusFading = savedConfirm === 'fading';
  } else {
    footerStatus = null;
  }
  const headerStatus = actionError
    ? 'Save error'
    : saving
      ? 'Saving…'
      : dirty
        ? 'Unsaved changes'
        : justSaved
          ? 'Saved just now'
          : undefined;
  const prepareBlocker = !canSave
    ? sourceStats.blockers[0]?.message ?? 'Resolve reference-material issues before preparing.'
    : !sourceStats.hasContent
      ? 'Add content to at least one source before preparing.'
      : null;
  // Preparation (the footer action) builds or refreshes the interview plan from
  // the reference material. Starting is a separate, always-available action.
  const prepLabel =
    preparing || planState === 'preparing'
      ? 'Preparing…'
      : planState === 'failed'
        ? 'Retry preparation'
        : planState === 'ready' || planState === 'stale' || dirty
          ? 'Update interview'
          : 'Prepare interview';
  const prepDisabled = preparing || saving || prepareBlocker !== null || planState === 'preparing';
  // An interview is technically startable the moment it's saved — even an
  // unprepared draft can launch (it just makes for a weaker interview). So the
  // header's Start action stays available instead of gating behind preparation.
  const canStartNow = savedId !== null;
  // Exactly one accent-filled primary action is on screen at a time. While the
  // plan is still incomplete OR has unsaved edits, the BOTTOM Continue/Prepare
  // action carries the accent and the header's Start is secondary. Once the plan
  // is ready AND saved, Start is promoted to primary and the footer action steps
  // down — so the two primaries never compete in the same viewport.
  const planReadyAndSaved = planState === 'ready' && !dirty && savedId !== null;
  const startInterview = (): void => {
    if (savedId !== null) {
      nav.go({ name: 'preflight', projectId: savedId });
    }
  };

  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const onLastStep = step === 'ready';
  const goNext = (): void => {
    const next = STEPS[stepIndex + 1];
    if (next) {
      setStep(next.key);
    }
  };
  const goBack = (): void => {
    if (stepIndex <= 0) {
      requestBack();
      return;
    }
    const prev = STEPS[stepIndex - 1];
    if (prev) {
      setStep(prev.key);
    }
  };

  const estimatedLength =
    form.targetMode === 'question_count' ? `${form.targetValue} questions` : `~${form.targetValue} min`;
  const briefComplete = form.title.trim() !== '';
  const interviewerName = selectedCharacter?.displayName ?? 'Mira';

  // A step reads as complete only once its own requirement is satisfied and it
  // sits behind the current step — so the stepper marks real progress, not just
  // position. Style and Ready carry no gate, so position alone settles them.
  const isStepComplete = (key: EditorStep): boolean => {
    const index = STEPS.findIndex((s) => s.key === key);
    if (index >= stepIndex) {
      return false;
    }
    if (key === 'brief') {
      return briefComplete;
    }
    if (key === 'reference') {
      return sourceStats.hasContent;
    }
    return true;
  };

  return (
    <div className={route.screen}>
      <PageHeader
        title={form.title.trim() || (savedId ? 'Untitled interview' : 'New interview')}
        leading={
          selectedCharacter?.profileImageUrl ? (
            <img
              className={styles.headerAvatar}
              src={selectedCharacter.profileImageUrl}
              alt={`Interviewer: ${interviewerName}`}
            />
          ) : undefined
        }
        meta={
          <span className={styles.headerSub}>
            <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
            {headerStatus != null && <span className={styles.headerFlash}>{headerStatus}</span>}
          </span>
        }
        onBack={requestBack}
        backLabel="Interviews"
        actions={
          <Button
            variant={planReadyAndSaved ? 'primary' : 'secondary'}
            className={styles.startButton}
            onClick={startInterview}
            disabled={!canStartNow}
            title={canStartNow ? 'Start the interview now' : 'Save the interview before starting'}
          >
            <Icon name="play" size={16} />
            Start interview
          </Button>
        }
      />

      <div className={route.screenBody}>
        <div className={styles.flowBody}>
          <ProgressSteps steps={STEPS} current={step} isComplete={isStepComplete} onSelect={setStep} />

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
            <StatusIcon tone={warnings.length > 0 ? 'warning' : 'success'} label="Preparation result" />
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

        {step === 'brief' && (
          <div className={styles.briefStep}>
          <Section title="Interview brief" description="What should Mira understand before the interview begins?">
            <div className={route.field}>
              <label className={route.label} htmlFor="project-title">
                Interview title
              </label>
              <input
                id="project-title"
                className={route.input}
                value={form.title}
                onChange={(e) => patch({ title: e.target.value })}
                placeholder="The founding story of Acme Robotics"
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
                  placeholder="Prospective customers and press"
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
                  placeholder="A candid narrative of the pivot"
                />
              </div>
            </div>
          </Section>
          </div>
        )}

        {step === 'reference' && (
          <SourceLibrary drafts={form.sources} onChange={setSources} onImportError={setActionError} />
        )}

        {step === 'style' && (
          <div className={`${styles.stepStack} ${styles.styleStep}`}>
            <Section title="Length" description="Land the interview on a number of questions or an approximate duration.">
              <div className={styles.lengthRow}>
                <SegmentedControl<TargetMode>
                  ariaLabel="Interview length mode"
                  value={form.targetMode}
                  onChange={(targetMode) => patch({ targetMode })}
                  segments={[
                    { value: 'question_count', label: 'Questions' },
                    { value: 'approximate_duration', label: 'Duration' },
                  ]}
                />
                <div className={styles.lengthValue}>
                  <input
                    id="project-target-value"
                    className={route.input}
                    type="number"
                    min={1}
                    aria-label={form.targetMode === 'question_count' ? 'Number of questions' : 'Approximate duration in minutes'}
                    value={form.targetValue}
                    onChange={(e) => {
                      const parsed = Number.parseInt(e.target.value, 10);
                      patch({ targetValue: Number.isFinite(parsed) && parsed > 0 ? parsed : 1 });
                    }}
                  />
                  <span className={styles.lengthUnit}>
                    {form.targetMode === 'question_count' ? 'questions' : 'minutes'}
                  </span>
                </div>
              </div>
            </Section>

            <Section title="Interviewer" description="Mira conducts the interview from your reference material.">
              <div className={styles.interviewerCard}>
                {selectedCharacter && (
                  <img
                    className={styles.interviewerImage}
                    src={selectedCharacter.profileImageUrl}
                    alt={`Portrait of ${selectedCharacter.displayName}`}
                  />
                )}
                <div className={styles.interviewerBody}>
                  <div className={styles.interviewerName}>{interviewerName}</div>
                  <div className={styles.interviewerDesc}>
                    {selectedCharacter?.shortDescription ?? 'Your interviewer'}
                  </div>
                </div>
                {characters.length > 1 && (
                  <select
                    id="project-character"
                    className={styles.interviewerSelect}
                    aria-label="Change interviewer"
                    value={form.interviewerCharacterId}
                    onChange={(e) => patch({ interviewerCharacterId: e.target.value })}
                  >
                    {characters.map((character) => (
                      <option key={character.id} value={character.id}>
                        {character.displayName}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </Section>

            <Section title="Style and boundaries" description="Tone, subjects to explore, and areas to avoid.">
              <MarkdownEditor
                value={form.notesToInterviewer}
                onChange={(value) => patch({ notesToInterviewer: value })}
                ariaLabel="Style and boundaries"
                minHeight="180px"
                placeholder="Keep the tone warm but probing. Avoid leading questions about funding."
              />
            </Section>
          </div>
        )}

        {step === 'ready' && (
          <div className={`${styles.stepStack} ${styles.readyStep}`}>
            <Section title="Ready to prepare" description={prepareBlocker ?? 'Everything looks good. Prepare the interview to generate the plan.'}>
              <dl className={styles.summary}>
                <SummaryRow label="Interview brief" value={briefComplete ? 'Complete' : 'Add a title'} ok={briefComplete} />
                <SummaryRow
                  label="Reference material"
                  value={`${sourceStats.documentCount} source${sourceStats.documentCount === 1 ? '' : 's'}`}
                  ok={sourceStats.hasContent}
                />
                <SummaryRow label="Interviewer" value={interviewerName} ok />
                <SummaryRow label="Estimated length" value={estimatedLength} ok />
              </dl>
              {prepareBlocker !== null && <p className={styles.prepareHint}>{prepareBlocker}</p>}
            </Section>

            {savedId !== null && (
              <Section title="Past sessions">
                {sessionsError !== null ? (
                  <p className={route.error} role="alert">
                    {sessionsError}
                  </p>
                ) : sessionHistory === null ? (
                  <p className={route.empty}>Loading sessions…</p>
                ) : sessionHistory.length === 0 ? (
                  <p className={route.empty}>No sessions yet. Prepare the interview, then start a conversation.</p>
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
                          <StatusPill tone={status.tone === 'active' ? 'accent' : status.tone === 'pending' ? 'neutral' : status.tone}>
                            {status.label}
                          </StatusPill>
                          <span className={styles.sessionTurns}>{session.currentTurnOrdinal} turns</span>
                          <Button variant="ghost" onClick={() => nav.go({ name: 'review', sessionId: session.id })}>
                            Review
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Section>
            )}
          </div>
        )}
        </div>
      </div>

      <div className={`${route.actionBar} ${route.actionBarSplit} ${styles.actionBarSlim}`}>
        <div className={`${route.actionBarInner} ${route.actionBarSplit}`}>
          <span
            className={`${styles.stepStatus}${footerStatusFading ? ` ${styles.footerStatusFade}` : ''}`}
          >
            {footerStatus}
          </span>
          <div className={styles.stepActions}>
            <Button variant="ghost" onClick={goBack}>
              {stepIndex <= 0 ? 'Interviews' : 'Back'}
            </Button>
            {onLastStep ? (
              <Button
                variant={planReadyAndSaved ? 'secondary' : 'primary'}
                onClick={() => void handlePrepare()}
                disabled={prepDisabled}
                title={prepareBlocker ?? 'Prepare the interview from these sources'}
              >
                {prepLabel}
              </Button>
            ) : (
              <Button variant={planReadyAndSaved ? 'secondary' : 'primary'} onClick={goNext}>
                Continue
              </Button>
            )}
          </div>
        </div>
      </div>

      <Sheet
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        tone="danger"
        title="Leave without saving?"
        description="You have unsaved changes to this interview."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={() => nav.go({ name: 'home' })}>
              Discard changes
            </Button>
          </>
        }
      />
    </div>
  );
}

function SummaryRow({ label, value, ok }: { label: string; value: string; ok: boolean }): JSX.Element {
  return (
    <div className={styles.summaryRow}>
      <dt>{label}</dt>
      <dd>
        <StatusIcon tone={ok ? 'success' : 'pending'} label={ok ? 'Ready' : 'Needs attention'} size={14} />
        {value}
      </dd>
    </div>
  );
}
