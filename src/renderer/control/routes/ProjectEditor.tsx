import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ProjectAggregate,
  ProjectId,
  SaveProjectInput,
  SaveProjectDocumentInput,
  TargetMode,
  PublicCharacterSummary,
} from '@shared/domain';
import type { Navigator } from '../app';
import { Button } from '../components/Button';
import { StatusIcon } from '../components/StatusIcon';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { describeError } from '../lib/errors';
import route from './route.module.css';
import styles from './ProjectEditor.module.css';

interface ProjectEditorProps {
  nav: Navigator;
  projectId: ProjectId | null;
}

interface DocumentDraft {
  id?: string;
  kind: 'primary' | 'reference';
  title: string;
  originalFilename: string | null;
  mimeType: 'text/markdown' | 'text/plain';
  content: string;
  sortOrder: number;
  key: string;
}

interface FormState {
  title: string;
  audience: string;
  intendedOutcome: string;
  targetMode: TargetMode;
  targetValue: number;
  notesToInterviewer: string;
  interviewerCharacterId: string;
  documents: DocumentDraft[];
}

const DEFAULT_CHARACTER_ID = 'mira';

let draftCounter = 0;
function nextKey(): string {
  draftCounter += 1;
  return `draft-${draftCounter}`;
}

function emptyForm(characterId: string): FormState {
  return {
    title: '',
    audience: '',
    intendedOutcome: '',
    targetMode: 'question_count',
    targetValue: 12,
    notesToInterviewer: '',
    interviewerCharacterId: characterId,
    documents: [
      {
        kind: 'primary',
        title: 'Source material',
        originalFilename: null,
        mimeType: 'text/markdown',
        content: '',
        sortOrder: 0,
        key: nextKey(),
      },
    ],
  };
}

function aggregateToForm(aggregate: ProjectAggregate): FormState {
  const project = aggregate.project;
  const documents: DocumentDraft[] = aggregate.documents
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((doc) => ({
      id: doc.id,
      kind: doc.kind,
      title: doc.title,
      originalFilename: doc.originalFilename,
      mimeType: doc.mimeType,
      content: doc.content,
      sortOrder: doc.sortOrder,
      key: nextKey(),
    }));
  if (!documents.some((doc) => doc.kind === 'primary')) {
    documents.unshift({
      kind: 'primary',
      title: 'Source material',
      originalFilename: null,
      mimeType: 'text/markdown',
      content: '',
      sortOrder: 0,
      key: nextKey(),
    });
  }
  return {
    title: project.title,
    audience: project.audience ?? '',
    intendedOutcome: project.intendedOutcome ?? '',
    targetMode: project.targetMode,
    targetValue: project.targetValue,
    notesToInterviewer: project.notesToInterviewer ?? '',
    interviewerCharacterId: project.interviewerCharacterId,
    documents,
  };
}

export function ProjectEditor({ nav, projectId }: ProjectEditorProps): JSX.Element {
  const [form, setForm] = useState<FormState | null>(null);
  const [savedId, setSavedId] = useState<ProjectId | null>(projectId);
  const [characters, setCharacters] = useState<PublicCharacterSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [prepared, setPrepared] = useState(false);
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
    if (projectId === null) {
      setForm(emptyForm(DEFAULT_CHARACTER_ID));
      setPrepared(false);
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
        setPrepared(aggregate.project.status === 'prepared');
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
    setPrepared(false);
  }, []);

  const updateDocument = useCallback((key: string, partial: Partial<DocumentDraft>) => {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            documents: prev.documents.map((doc) => (doc.key === key ? { ...doc, ...partial } : doc)),
          }
        : prev,
    );
    setPrepared(false);
  }, []);

  const removeDocument = useCallback((key: string) => {
    setForm((prev) =>
      prev ? { ...prev, documents: prev.documents.filter((doc) => doc.key !== key) } : prev,
    );
    setPrepared(false);
  }, []);

  const importReference = useCallback(async () => {
    setActionError(null);
    try {
      const imported = await window.candidcue.projects.importDocument();
      if (imported === null) {
        return;
      }
      setForm((prev) => {
        if (!prev) {
          return prev;
        }
        const maxSort = prev.documents.reduce((max, doc) => Math.max(max, doc.sortOrder), 0);
        const mimeType: 'text/markdown' | 'text/plain' =
          imported.mimeType === 'text/plain' ? 'text/plain' : 'text/markdown';
        const doc: DocumentDraft = {
          kind: 'reference',
          title: imported.title || imported.filename,
          originalFilename: imported.filename,
          mimeType,
          content: imported.content,
          sortOrder: maxSort + 1,
          key: nextKey(),
        };
        return { ...prev, documents: [...prev.documents, doc] };
      });
      setPrepared(false);
    } catch (err: unknown) {
      setActionError(describeError(err));
    }
  }, []);

  const buildInput = useCallback(
    (state: FormState, id: ProjectId | null): SaveProjectInput => {
      const documents: SaveProjectDocumentInput[] = state.documents.map((doc, index) => {
        const base: SaveProjectDocumentInput = {
          kind: doc.kind,
          title: doc.title,
          originalFilename: doc.originalFilename,
          mimeType: doc.mimeType,
          content: doc.content,
          sortOrder: index,
        };
        return doc.id ? { ...base, id: doc.id } : base;
      });
      const input: SaveProjectInput = {
        title: state.title.trim() || 'Untitled project',
        audience: state.audience.trim() ? state.audience.trim() : null,
        intendedOutcome: state.intendedOutcome.trim() ? state.intendedOutcome.trim() : null,
        targetMode: state.targetMode,
        targetValue: state.targetValue,
        interviewerCharacterId: state.interviewerCharacterId,
        notesToInterviewer: state.notesToInterviewer.trim() ? state.notesToInterviewer.trim() : null,
        documents,
      };
      return id ? { ...input, id } : input;
    },
    [],
  );

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
      setPrepared(aggregate.project.status === 'prepared');
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
        setPrepared(true);
      } else if (result.error) {
        setActionError(result.error.publicMessage);
      }
    } catch (err: unknown) {
      setActionError(describeError(err));
    } finally {
      setPreparing(false);
    }
  }, [handleSave]);

  const selectedCharacter = useMemo<PublicCharacterSummary | null>(() => {
    if (!form) {
      return null;
    }
    return characters.find((c) => c.id === form.interviewerCharacterId) ?? null;
  }, [characters, form]);

  if (!form) {
    return (
      <div className={route.page}>
        <p className={route.empty}>{loadError ?? 'Loading project…'}</p>
      </div>
    );
  }

  const primaryDoc = form.documents.find((doc) => doc.kind === 'primary');
  const referenceDocs = form.documents.filter((doc) => doc.kind === 'reference');
  const totalChars = form.documents.reduce((sum, doc) => sum + doc.content.length, 0);

  return (
    <div className={`${route.page} ${route.pageWide}`}>
      <div className={route.pageHeader}>
        <div>
          <h1 className={route.title}>{savedId ? 'Edit project' : 'New interview project'}</h1>
          <p className={route.subtitle}>
            Describe the interview and provide the source material. Imported documents are treated
            as reference material only.
          </p>
        </div>
        <div className={route.headerActions}>
          {prepared && (
            <span className={styles.preparedBadge}>
              <StatusIcon tone="success" label="Prepared" /> Prepared
            </span>
          )}
          <Button variant="ghost" onClick={() => nav.go({ name: 'home' })}>
            Back
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="primary" onClick={() => void handlePrepare()} disabled={preparing || saving}>
            {preparing ? 'Preparing…' : 'Prepare interview'}
          </Button>
          {savedId && (
            <Button
              variant="secondary"
              onClick={() => nav.go({ name: 'preflight', projectId: savedId })}
              disabled={!prepared}
              title={prepared ? 'Start a session' : 'Prepare the interview first'}
            >
              Start session
            </Button>
          )}
        </div>
      </div>

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

      <section className={`${route.panel} ${route.section}`}>
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
      </section>

      <section className={`${route.panel} ${route.section}`}>
        <div>
          <h2 className={route.sectionTitle}>Interviewer</h2>
          <p className={route.sectionHint}>Mira conducts the interview using your source material.</p>
        </div>
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
      </section>

      <section className={`${route.panel} ${route.section}`}>
        <div>
          <h2 className={route.sectionTitle}>Notes to Mira</h2>
          <p className={route.sectionHint}>
            Steering for the interviewer — tone, areas to probe, things to avoid.
          </p>
        </div>
        <MarkdownEditor
          value={form.notesToInterviewer}
          onChange={(value) => patch({ notesToInterviewer: value })}
          ariaLabel="Notes to Mira"
          minHeight="120px"
          placeholder="Keep the tone warm but probing. Avoid leading questions about funding."
        />
      </section>

      <section className={`${route.panel} ${route.section}`}>
        <div className={styles.sourceHeader}>
          <div>
            <h2 className={route.sectionTitle}>Source material</h2>
            <p className={route.sectionHint}>
              The primary document is the backbone of the interview. Reference documents add
              supporting context.
            </p>
          </div>
          <div className={styles.charCount}>
            <span>{totalChars.toLocaleString()} characters</span>
            <Button variant="secondary" onClick={() => void importReference()}>
              Import .md / .txt
            </Button>
          </div>
        </div>

        {primaryDoc && (
          <div className={styles.document}>
            <div className={styles.documentHeader}>
              <span className={styles.documentLabel}>
                <StatusIcon tone="active" label="Primary document" /> Primary document
              </span>
              <span className={route.count}>{primaryDoc.content.length.toLocaleString()} chars</span>
            </div>
            <MarkdownEditor
              value={primaryDoc.content}
              onChange={(value) => updateDocument(primaryDoc.key, { content: value })}
              ariaLabel="Primary source document"
              minHeight="240px"
              placeholder="Paste or write the main material the interview draws on…"
            />
          </div>
        )}

        {referenceDocs.map((doc) => (
          <div key={doc.key} className={styles.document}>
            <div className={styles.documentHeader}>
              <input
                className={styles.documentTitleInput}
                value={doc.title}
                aria-label="Reference document title"
                onChange={(e) => updateDocument(doc.key, { title: e.target.value })}
              />
              <span className={styles.documentMeta}>
                <span className={route.count}>{doc.content.length.toLocaleString()} chars</span>
                <Button variant="ghost" onClick={() => removeDocument(doc.key)} aria-label={`Remove ${doc.title}`}>
                  Remove
                </Button>
              </span>
            </div>
            {doc.originalFilename && (
              <span className={styles.filename}>Imported from {doc.originalFilename}</span>
            )}
            <MarkdownEditor
              value={doc.content}
              onChange={(value) => updateDocument(doc.key, { content: value })}
              ariaLabel={`Reference document: ${doc.title}`}
              minHeight="160px"
            />
          </div>
        ))}
      </section>
    </div>
  );
}
