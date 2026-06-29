import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionReview, SessionReviewTurn, ExportResult } from '@shared/contracts';
import type { Navigator } from '../app';
import { StatusIcon } from '../components/StatusIcon';
import { StatusPill } from '../components/StatusPill';
import { PageHeader } from '../components/PageHeader';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { OverflowMenu, type OverflowMenuItem } from '../components/OverflowMenu';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { describeError } from '../lib/errors';
import { formatTimestamp } from '../lib/format';
import route from './route.module.css';
import styles from './ReviewScreen.module.css';

interface ReviewScreenProps {
  nav: Navigator;
  sessionId: string;
}

interface TurnEditState {
  text: string;
  dirty: boolean;
  saving: boolean;
  saved: boolean;
}

function initialEditText(turn: SessionReviewTurn): string {
  // A present-but-empty cleaned transcript falls through to the raw transcript:
  // raw-only answers (END_NOW / recovery) carry an empty cleaned transcript, and
  // `??` alone would seed the editor blank despite captured speech (#74).
  return turn.userEditedTranscript ?? (turn.cleanedTranscript || turn.rawTranscript) ?? '';
}

function turnKey(turn: SessionReviewTurn): string {
  return `turn-${turn.ordinal}`;
}

// Scroll a turn into view from the index. Honor prefers-reduced-motion: when the
// user has asked for less motion, jump instantly instead of forcing a smooth
// scroll across the whole document.
function scrollToTurn(key: string): void {
  const node = document.getElementById(key);
  if (!node) {
    return;
  }
  const reduceMotion =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  node.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
}

function formatDuration(startedAt: string | null, endedAt: string | null): string | null {
  if (!startedAt || !endedAt) {
    return null;
  }
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) {
    return null;
  }
  return `${Math.max(1, Math.round((ended - started) / 60_000))} min`;
}

export function ReviewScreen({ nav, sessionId }: ReviewScreenProps): JSX.Element {
  const [review, setReview] = useState<SessionReview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, TurnEditState>>({});
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    window.candidcue.sessions
      .review(sessionId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result === null) {
          setLoadError('This session could not be found.');
          return;
        }
        setReview(result);
        const seeded: Record<string, TurnEditState> = {};
        result.turns.forEach((turn) => {
          seeded[turnKey(turn)] = { text: initialEditText(turn), dirty: false, saving: false, saved: false };
        });
        setEdits(seeded);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(describeError(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const updateEdit = useCallback((key: string, text: string) => {
    setEdits((prev) => {
      const current = prev[key];
      if (!current) {
        return prev;
      }
      return { ...prev, [key]: { ...current, text, dirty: true, saved: false } };
    });
  }, []);

  // Persist a specific text snapshot. The text is captured explicitly so a save
  // in flight can be reconciled against newer typing: only mark the turn clean
  // if nothing changed during the await, otherwise leave it dirty to re-save.
  const saveEdit = useCallback(async (turn: SessionReviewTurn, textToSave: string) => {
    const key = turnKey(turn);
    setEdits((prev) => {
      const current = prev[key];
      return current ? { ...prev, [key]: { ...current, saving: true } } : prev;
    });
    setExportError(null);
    try {
      await window.candidcue.sessions.editTranscript(turn.id, textToSave);
      setEdits((prev) => {
        const current = prev[key];
        if (!current) {
          return prev;
        }
        const stillDirty = current.text !== textToSave;
        return { ...prev, [key]: { ...current, saving: false, dirty: stillDirty, saved: !stillDirty } };
      });
    } catch (err: unknown) {
      setExportError(describeError(err));
      setEdits((prev) => {
        const current = prev[key];
        return current ? { ...prev, [key]: { ...current, saving: false } } : prev;
      });
    }
  }, []);

  // Autosave the turn being edited shortly after the last keystroke.
  useEffect(() => {
    if (editingKey === null) {
      return undefined;
    }
    const edit = edits[editingKey];
    const turn = review?.turns.find((t) => turnKey(t) === editingKey);
    if (!edit || !edit.dirty || edit.saving || !turn) {
      return undefined;
    }
    const text = edit.text;
    const timer = window.setTimeout(() => void saveEdit(turn, text), 1000);
    return () => window.clearTimeout(timer);
  }, [editingKey, edits, review, saveEdit]);

  // Flush a pending edit before leaving a turn (Done / switch / unmount) so the
  // debounce window can never swallow the last change.
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const editingKeyRef = useRef(editingKey);
  editingKeyRef.current = editingKey;

  const flushEditing = useCallback(() => {
    const key = editingKeyRef.current;
    if (key === null) {
      return;
    }
    const edit = editsRef.current[key];
    const turn = reviewRef.current?.turns.find((t) => turnKey(t) === key);
    if (edit && edit.dirty && !edit.saving && turn) {
      void saveEdit(turn, edit.text);
    }
  }, [saveEdit]);

  const setEditing = useCallback(
    (nextKey: string | null) => {
      flushEditing();
      setEditingKey(nextKey);
    },
    [flushEditing],
  );

  useEffect(() => () => flushEditing(), [flushEditing]);

  // Track which question is currently in view so the sticky index can mark it.
  // The topmost intersecting turn wins, giving the index a stable reading position
  // as the document scrolls rather than flickering between neighbours.
  useEffect(() => {
    if (review === null || review.turns.length === 0) {
      return undefined;
    }
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visible.set(entry.target.id, entry.boundingClientRect.top);
          } else {
            visible.delete(entry.target.id);
          }
        }
        let topKey: string | null = null;
        let topY = Infinity;
        visible.forEach((y, id) => {
          if (y < topY) {
            topY = y;
            topKey = id;
          }
        });
        setActiveKey(topKey);
      },
      // Top inset matches the sticky header offset (--header-back-meta-h 123px +
      // 16px gap) so a turn flips to "active" exactly as it clears the header.
      { rootMargin: '-139px 0px -55% 0px', threshold: 0 },
    );
    review.turns.forEach((turn) => {
      const node = document.getElementById(turnKey(turn));
      if (node) {
        observer.observe(node);
      }
    });
    return () => observer.disconnect();
  }, [review]);

  const handleExport = useCallback(
    async (format: 'markdown' | 'json') => {
      setExportNote(null);
      setExportError(null);
      try {
        const result: ExportResult = await window.candidcue.sessions.export(sessionId, format);
        if (result.ok && result.path) {
          setExportNote(`Exported ${format} to ${result.path}.`);
        } else if (result.error) {
          setExportError(result.error.publicMessage);
        } else {
          setExportNote(`Exported ${format}.`);
        }
      } catch (err: unknown) {
        setExportError(describeError(err));
      }
    },
    [sessionId],
  );

  if (loadError !== null) {
    return (
      <>
        <PageHeader title="Review" onBack={() => nav.go({ name: 'home' })} backLabel="Interviews" />
        <div className={route.page}>
          <p className={route.error} role="alert">
            {loadError}
          </p>
        </div>
      </>
    );
  }

  if (review === null) {
    return (
      <>
        <PageHeader title="Review" onBack={() => nav.go({ name: 'home' })} backLabel="Interviews" />
        <div className={route.page}>
          <p className={route.empty}>Loading the interview…</p>
        </div>
      </>
    );
  }

  const duration = formatDuration(review.startedAt, review.endedAt);
  const completed = review.endedAt !== null;
  const metaParts = [formatTimestamp(review.startedAt)];
  if (duration) {
    metaParts.push(duration);
  }
  metaParts.push(`${review.turns.length} question${review.turns.length === 1 ? '' : 's'}`);

  const menuItems: OverflowMenuItem[] = [
    {
      label: showRaw ? 'Show cleaned answers' : 'Show original transcript',
      onSelect: () => setShowRaw((v) => !v),
      active: showRaw,
    },
    { label: 'Export as JSON', onSelect: () => void handleExport('json'), icon: 'download' },
  ];

  return (
    <>
      <PageHeader
        title={review.projectTitle || 'Interview'}
        onBack={() => nav.go({ name: 'home' })}
        backLabel="Interviews"
        meta={metaParts.join(' · ')}
        status={
          <StatusPill tone={completed ? 'success' : 'neutral'}>{completed ? 'Completed' : 'In progress'}</StatusPill>
        }
        actions={
          <div className={styles.toolbar}>
            <Button variant="secondary" onClick={() => void handleExport('markdown')}>
              <Icon name="download" size={16} /> Export
            </Button>
            <OverflowMenu items={menuItems} ariaLabel="Review options" />
          </div>
        }
      />
      <div className={styles.review}>
        <nav className={styles.index} aria-label="Questions">
          <ol className={styles.indexList}>
            {review.turns.map((turn) => {
              const key = turnKey(turn);
              const active = activeKey === key;
              return (
                <li key={key}>
                  <button
                    type="button"
                    className={styles.indexItem}
                    data-active={active || undefined}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => scrollToTurn(key)}
                  >
                    <span className={styles.indexNum}>{turn.ordinal}</span>
                    <span className={styles.indexQuestion}>{turn.question}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className={styles.document}>
          {exportNote !== null && (
            <div className={styles.exportNotice} role="status">
              <StatusIcon tone="success" label="Exported" />
              <span>{exportNote}</span>
            </div>
          )}
          {exportError !== null && (
            <p className={route.error} role="alert">
              {exportError}
            </p>
          )}

          {review.turns.length === 0 ? (
            <p className={route.empty}>This interview has no recorded answers.</p>
          ) : (
            review.turns.map((turn) => {
              const key = turnKey(turn);
              const edit = edits[key];
              const editing = editingKey === key;
              return (
                <article key={key} id={key} className={styles.turn}>
                  <div className={styles.block}>
                    <span className={styles.speakerMira}>Mira</span>
                    <p className={styles.question}>{turn.question}</p>
                  </div>

                  <div className={styles.block}>
                    <div className={styles.youHead} data-editing={editing || undefined}>
                      <span className={styles.speakerYou}>You</span>
                      {turn.incomplete && (
                        <span className={styles.flag}>
                          <StatusIcon tone="warning" label="Incomplete answer" size={13} /> Incomplete
                        </span>
                      )}
                      {turn.endpointReason === 'recovery' && (
                        <span className={styles.flag}>
                          <StatusIcon tone="pending" label="Recovered transcript" size={13} /> Recovered
                        </span>
                      )}
                      <span className={styles.youSpacer} />
                      {!showRaw &&
                        (edit?.saving ? (
                          <span className={styles.saveState}>Saving…</span>
                        ) : edit?.saved && !edit.dirty ? (
                          <span className={styles.saveState}>
                            <StatusIcon tone="success" label="Saved" size={13} /> Saved
                          </span>
                        ) : null)}
                      {!showRaw && (
                        <button
                          type="button"
                          className={styles.editToggle}
                          onClick={() => setEditing(editing ? null : key)}
                        >
                          {editing ? 'Done' : 'Edit'}
                        </button>
                      )}
                    </div>

                    {showRaw ? (
                      <p className={styles.answerText}>
                        {turn.rawTranscript ?? <span className={styles.muted}>No original transcript.</span>}
                      </p>
                    ) : editing ? (
                      <MarkdownEditor
                        value={edit?.text ?? initialEditText(turn)}
                        onChange={(value) => updateEdit(key, value)}
                        ariaLabel={`Answer to: ${turn.question}`}
                        minHeight="120px"
                      />
                    ) : (
                      <AnswerText text={edit?.text ?? initialEditText(turn)} />
                    )}
                  </div>
                </article>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

function AnswerText({ text }: { text: string }): JSX.Element {
  const trimmed = text.trim();
  if (trimmed === '') {
    return <p className={styles.answerText}><span className={styles.muted}>No answer recorded.</span></p>;
  }
  const paragraphs = trimmed.split(/\n{2,}/);
  return (
    <div className={styles.answerProse}>
      {paragraphs.map((para, index) => (
        <p key={index} className={styles.answerText}>
          {para}
        </p>
      ))}
    </div>
  );
}
