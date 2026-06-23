import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ProjectAggregate,
  ProjectId,
  ProjectPlanState,
  SaveProjectInput,
  TargetMode,
  PublicCharacterSummary,
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
import { StatusIcon } from '../components/StatusIcon';
import type { StatusTone } from '../components/StatusIcon';
import { Panel } from '../components/Panel';
import { WorkspaceToolbar } from '../components/WorkspaceToolbar';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { SourceLibrary } from '../components/SourceLibrary';
import { nextDraftKey } from '../lib/draft-key';
import { describeError } from '../lib/errors';
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
  unprepared: { tone: 'pending', label: 'Not prepared' },
  preparing: { tone: 'active', label: 'Preparing…' },
  ready: { tone: 'success', label: 'Prepared' },
  stale: { tone: 'warning', label: 'Re-prepare needed' },
  failed: { tone: 'danger', label: 'Preparation failed' },
};

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
        <WorkspaceToolbar
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
  const badge = dirty
    ? ({ tone: 'pending', label: 'Unsaved changes' } as const)
    : PLAN_BADGE[planState];
  // What blocks Prepare, in priority order, surfaced as an inline hint.
  const prepareBlocker = !canSave
    ? sourceStats.blockers[0]?.message ?? 'Resolve source issues before preparing.'
    : sourceStats.primaryEmpty
      ? 'Add content to the primary source before preparing.'
      : null;

  return (
    <>
      <WorkspaceToolbar
        title={savedId ? 'Edit project' : 'New project'}
        onBack={requestBack}
        actions={
          <>
            <span className={styles.preparedBadge}>
              <StatusIcon tone={badge.tone} label={badge.label} /> {badge.label}
            </span>
            <Button onClick={() => void handleSave()} disabled={saving || !canSave}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button
              variant="primary"
              onClick={() => void handlePrepare()}
              disabled={preparing || saving || prepareBlocker !== null}
              title={prepareBlocker ?? 'Prepare the interview from these sources'}
            >
              {preparing ? 'Preparing…' : 'Prepare interview'}
            </Button>
            {savedId && (
              <Button
                variant="secondary"
                onClick={() => nav.go({ name: 'preflight', projectId: savedId })}
                disabled={!readyToStart}
                title={readyToStart ? 'Start a session' : 'Prepare the interview first'}
              >
                Start session
              </Button>
            )}
          </>
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

        <Panel title="Project">
          <div className={route.field}>
            <label className={route.label} htmlFor="project-title">
              Title
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

          <div className={route.row}>
            <div className={`${route.field} ${route.rowItem}`}>
              <label className={route.label} htmlFor="project-target-mode">
                Target mode
              </label>
              <select
                id="project-target-mode"
                className={route.select}
                value={form.targetMode}
                onChange={(e) => patch({ targetMode: e.target.value as TargetMode })}
              >
                <option value="question_count">Question count</option>
                <option value="approximate_duration">Approximate duration (minutes)</option>
              </select>
            </div>
            <div className={`${route.field} ${route.rowItem}`}>
              <label className={route.label} htmlFor="project-target-value">
                {form.targetMode === 'question_count' ? 'Number of questions' : 'Duration (minutes)'}
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
        </Panel>

        <Panel title="Interviewer">
          <p className={route.sectionHint}>
            Mira conducts the interview using your source material.
          </p>
          <div className={route.field}>
            <label className={route.label} htmlFor="project-character">
              Interviewer
            </label>
            <select
              id="project-character"
              className={route.select}
              value={form.interviewerCharacterId}
              onChange={(e) => patch({ interviewerCharacterId: e.target.value })}
            >
              {characters.length === 0 && (
                <option value={form.interviewerCharacterId}>{form.interviewerCharacterId}</option>
              )}
              {characters.map((character) => (
                <option key={character.id} value={character.id}>
                  {character.displayName} — {character.shortDescription}
                </option>
              ))}
            </select>
          </div>
          {selectedCharacter && (
            <div className={styles.characterCard}>
              <img
                className={styles.characterImage}
                src={selectedCharacter.profileImageUrl}
                alt={`Portrait of ${selectedCharacter.displayName}`}
              />
              <div>
                <div className={styles.characterName}>{selectedCharacter.displayName}</div>
                <div className={styles.characterDesc}>{selectedCharacter.shortDescription}</div>
              </div>
            </div>
          )}
        </Panel>

        <Panel title="Notes to Mira">
          <p className={route.sectionHint}>
            Steering for the interviewer — tone, areas to probe, things to avoid.
          </p>
          <MarkdownEditor
            value={form.notesToInterviewer}
            onChange={(value) => patch({ notesToInterviewer: value })}
            ariaLabel="Notes to Mira"
            minHeight="120px"
            placeholder="Keep the tone warm but probing. Avoid leading questions about funding."
          />
        </Panel>

        <SourceLibrary
          drafts={form.sources}
          onChange={setSources}
          onImportError={setActionError}
        />
      </div>
    </>
  );
}
