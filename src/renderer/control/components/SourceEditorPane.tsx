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
  /** Delete is disabled when only one source remains. */
  canDelete: boolean;
  onTitleChange: (title: string) => void;
  onContentChange: (content: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

/**
 * The right pane of the Sources workspace: edits the selected source's title and
 * Markdown content. The title sits in the editor's integrated header strip, and
 * the per-source actions (duplicate, delete) live alongside it. Delete is a
 * two-step confirm. Holds the only CodeMirror surface.
 */
export function SourceEditorPane({
  draft,
  stat,
  canDelete,
  onTitleChange,
  onContentChange,
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
        <p className={styles.paneEmpty}>Select a source to edit, or add one to begin.</p>
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
      <input
        className={styles.editorTitleInput}
        value={draft.title}
        maxLength={PROJECT_SOURCE_LIMITS.maxTitleCharacters}
        aria-label="Source title"
        placeholder="Untitled source"
        onChange={(event) => onTitleChange(event.target.value)}
      />
      <div className={styles.editorActions}>
        <Button
          variant="ghost"
          className={styles.editorAction}
          onClick={onDuplicate}
          title="Duplicate this source"
        >
          <Icon name="copy" size={15} /> Duplicate
        </Button>
        {confirmingDelete ? (
          <Button
            variant="danger"
            className={styles.confirmDelete}
            onClick={handleDelete}
            title="Click again to delete this source"
          >
            <Icon name="trash" size={15} /> Confirm delete
          </Button>
        ) : (
          <Button
            variant="ghost"
            className={styles.iconDanger}
            onClick={handleDelete}
            disabled={!canDelete}
            aria-label="Delete source"
            title={canDelete ? 'Delete this source' : 'An interview keeps at least one source'}
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
        ariaLabel={`Editing source: ${draft.title || 'Untitled source'}`}
        minHeight="360px"
        header={editorHeader}
        placeholder="Paste or write the material Mira can draw on…"
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
