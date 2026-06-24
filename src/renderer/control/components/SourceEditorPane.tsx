import { useEffect, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { MarkdownEditor } from './MarkdownEditor';
import { PROJECT_SOURCE_LIMITS } from '@shared/constants/project-source-limits';
import type { SourceDraft } from '@shared/project-source-draft';
import type { SourceDocumentStat } from '@shared/project-source-stats';
import styles from './SourceLibrary.module.css';

interface SourceEditorPaneProps {
  draft: SourceDraft | null;
  stat: SourceDocumentStat | null;
  /** True when this draft is the primary (index 0). */
  isPrimary: boolean;
  /** Delete is disabled when only one source remains. */
  canDelete: boolean;
  onTitleChange: (title: string) => void;
  onContentChange: (content: string) => void;
  onMakePrimary: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

/**
 * The right pane of the Sources workspace: edits the selected source's title and
 * Markdown content. The title sits in the editor's integrated header strip with
 * a primary-marking star, and the per-source actions (duplicate, delete) live
 * alongside it. Delete is a two-step confirm. Holds the only CodeMirror surface.
 */
export function SourceEditorPane({
  draft,
  stat,
  isPrimary,
  canDelete,
  onTitleChange,
  onContentChange,
  onMakePrimary,
  onDuplicate,
  onDelete,
}: SourceEditorPaneProps): JSX.Element {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Disarm the delete confirm whenever the selection changes, and auto-disarm a
  // few seconds after arming so a stray first click never lingers as a trap.
  const draftKey = draft?.key ?? null;
  useEffect(() => {
    setConfirmingDelete(false);
  }, [draftKey]);
  useEffect(() => {
    if (!confirmingDelete) {
      return undefined;
    }
    const timer = setTimeout(() => setConfirmingDelete(false), 3500);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);

  if (!draft) {
    return (
      <div className={styles.pane}>
        <p className={styles.paneEmpty}>Select a reference to edit, or add one to begin.</p>
      </div>
    );
  }

  const characters = stat?.characters ?? draft.content.length;

  const handleDelete = (): void => {
    if (!canDelete) {
      return;
    }
    if (confirmingDelete) {
      onDelete();
      setConfirmingDelete(false);
    } else {
      setConfirmingDelete(true);
    }
  };

  const editorHeader = (
    <>
      {isPrimary ? (
        <span className={styles.editorStar} title="Primary reference" aria-label="Primary reference">
          <Icon name="starFilled" size={16} aria-hidden />
        </span>
      ) : (
        <button
          type="button"
          className={styles.editorStarButton}
          onClick={onMakePrimary}
          title="Make this the primary reference"
          aria-label="Make this the primary reference"
        >
          <Icon name="star" size={16} />
        </button>
      )}
      <input
        className={styles.editorTitleInput}
        value={draft.title}
        maxLength={PROJECT_SOURCE_LIMITS.maxTitleCharacters}
        aria-label="Reference title"
        placeholder={isPrimary ? 'Primary reference' : 'Untitled reference'}
        onChange={(event) => onTitleChange(event.target.value)}
      />
      <div className={styles.editorActions}>
        <Button
          variant="ghost"
          className={styles.editorAction}
          onClick={onDuplicate}
          title="Duplicate this reference"
        >
          <Icon name="copy" size={15} /> Duplicate
        </Button>
        {confirmingDelete ? (
          <Button
            variant="danger"
            className={styles.confirmDelete}
            onClick={handleDelete}
            title="Click again to delete this reference"
          >
            <Icon name="trash" size={15} /> Confirm delete
          </Button>
        ) : (
          <Button
            variant="ghost"
            className={styles.iconDanger}
            onClick={handleDelete}
            disabled={!canDelete}
            aria-label="Delete reference"
            title={canDelete ? 'Delete this reference' : 'An interview keeps at least one reference'}
          >
            <Icon name="trash" size={15} />
          </Button>
        )}
      </div>
    </>
  );

  return (
    <div className={styles.pane}>
      <MarkdownEditor
        key={draft.key}
        flush
        value={draft.content}
        onChange={onContentChange}
        ariaLabel={`Editing reference: ${draft.title || 'Untitled reference'}`}
        minHeight="360px"
        header={editorHeader}
        placeholder={
          isPrimary
            ? 'Paste or write the main material the interview draws on…'
            : 'Supporting context Mira can draw on…'
        }
      />

      <p className={styles.editorStatusBar}>
        <span className={styles.editorChars}>{characters.toLocaleString()} characters</span>
        {draft.originalFilename && (
          <span className={styles.editorFile}>Imported from {draft.originalFilename}</span>
        )}
      </p>
    </div>
  );
}
