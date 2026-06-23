import { useCallback, useEffect, useState } from 'react';
import type { SessionReview, SessionReviewTurn, ExportResult } from '@shared/contracts';
import type { Navigator } from '../app';
import { Button } from '../components/Button';
import { StatusIcon } from '../components/StatusIcon';
import { MarkdownEditor } from '../components/MarkdownEditor';
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
  return turn.userEditedTranscript ?? turn.cleanedTranscript ?? turn.rawTranscript ?? '';
}

export function ReviewScreen({ nav, sessionId }: ReviewScreenProps): JSX.Element {
  const [review, setReview] = useState<SessionReview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
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
          seeded[turnKey(turn)] = {
            text: initialEditText(turn),
            dirty: false,
            saving: false,
            saved: false,
          };
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

  const saveEdit = useCallback(async (turn: SessionReviewTurn) => {
    const key = turnKey(turn);
    setEdits((prev) => {
      const current = prev[key];
      return current ? { ...prev, [key]: { ...current, saving: true } } : prev;
    });
    setExportError(null);
    try {
      const text = edits[key]?.text ?? initialEditText(turn);
      await window.candidcue.sessions.editTranscript(turnId(turn), text);
      setEdits((prev) => {
        const current = prev[key];
        return current ? { ...prev, [key]: { ...current, dirty: false, saving: false, saved: true } } : prev;
      });
    } catch (err: unknown) {
      setExportError(describeError(err));
      setEdits((prev) => {
        const current = prev[key];
        return current ? { ...prev, [key]: { ...current, saving: false } } : prev;
      });
    }
  }, [edits]);

  const handleExport = useCallback(async (format: 'markdown' | 'json') => {
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
  }, [sessionId]);

  if (loadError !== null) {
    return (
      <div className={route.page}>
        <p className={route.error} role="alert">
          {loadError}
        </p>
        <Button variant="ghost" onClick={() => nav.go({ name: 'home' })}>
          Back to projects
        </Button>
      </div>
    );
  }

  if (review === null) {
    return (
      <div className={route.page}>
        <p className={route.empty}>Loading session review…</p>
      </div>
    );
  }

  return (
    <div className={`${route.page} ${route.pageWide}`}>
      <div className={route.pageHeader}>
        <div>
          <h1 className={route.title}>{review.projectTitle}</h1>
          <p className={route.subtitle}>
            {formatTimestamp(review.startedAt)} → {formatTimestamp(review.endedAt)} ·{' '}
            {review.turns.length} turn(s)
          </p>
        </div>
        <div className={route.headerActions}>
          <Button variant="ghost" onClick={() => setShowRaw((v) => !v)} aria-pressed={showRaw}>
            {showRaw ? 'Show cleaned' : 'Show raw'}
          </Button>
          <Button variant="secondary" onClick={() => void handleExport('markdown')}>
            Export Markdown
          </Button>
          <Button variant="secondary" onClick={() => void handleExport('json')}>
            Export JSON
          </Button>
          <Button variant="ghost" onClick={() => nav.go({ name: 'home' })}>
            Done
          </Button>
        </div>
      </div>

      {exportNote !== null && (
        <div className={route.notice} role="status">
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
        <div className={route.panel}>
          <p className={route.empty}>This session has no recorded turns.</p>
        </div>
      ) : (
        <ol className={styles.turnList}>
          {review.turns.map((turn) => {
            const key = turnKey(turn);
            const edit = edits[key];
            return (
              <li key={key} className={route.panel}>
                <div className={styles.turnHeader}>
                  <span className={styles.turnOrdinal}>Turn {turn.ordinal}</span>
                  <div className={styles.turnFlags}>
                    {turn.incomplete && (
                      <span className={styles.flag}>
                        <StatusIcon tone="warning" label="Incomplete answer" /> Incomplete
                      </span>
                    )}
                    {turn.endpointReason === 'recovery' && (
                      <span className={styles.flag}>
                        <StatusIcon tone="pending" label="Recovered transcript" /> Recovered
                      </span>
                    )}
                  </div>
                </div>

                <p className={styles.question}>{turn.question}</p>

                <div className={styles.answerBlock}>
                  <span className={styles.answerLabel}>{showRaw ? 'Raw transcript' : 'Cleaned answer'}</span>
                  {showRaw ? (
                    <p className={styles.rawText}>
                      {turn.rawTranscript ?? <span className={route.empty}>No raw transcript.</span>}
                    </p>
                  ) : (
                    <MarkdownEditor
                      value={edit?.text ?? initialEditText(turn)}
                      onChange={(value) => updateEdit(key, value)}
                      ariaLabel={`Edited transcript for turn ${turn.ordinal}`}
                      minHeight="120px"
                    />
                  )}
                </div>

                {!showRaw && (
                  <div className={styles.turnActions}>
                    <Button onClick={() => void saveEdit(turn)} disabled={!edit?.dirty || edit?.saving}>
                      {edit?.saving ? 'Saving…' : 'Save edit'}
                    </Button>
                    {edit?.saved && !edit.dirty && (
                      <span className={styles.savedNote}>
                        <StatusIcon tone="success" label="Saved" /> Saved
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** Stable key for a turn — ordinal is unique within a review. */
function turnKey(turn: SessionReviewTurn): string {
  return `turn-${turn.ordinal}`;
}

/**
 * The edit API keys on a turn id. The review projection exposes ordinal as the
 * stable identifier, so we use it as the turn id for the edit call.
 */
function turnId(turn: SessionReviewTurn): string {
  return String(turn.ordinal);
}
