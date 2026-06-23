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
 * Markdown content, and exposes the per-source actions (make primary, duplicate,
 * delete). Holds the only CodeMirror surface in the library.
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
  if (!draft) {
    return (
      <div className={styles.pane}>
        <p className={styles.paneEmpty}>Select a source to edit, or import Markdown to add one.</p>
      </div>
    );
  }

  const characters = stat?.characters ?? draft.content.length;
  const overLimit = stat?.overCharacterLimit ?? false;

  return (
    <div className={styles.pane}>
      <div className={styles.paneHeader}>
        <input
          className={styles.titleInput}
          value={draft.title}
          maxLength={PROJECT_SOURCE_LIMITS.maxTitleCharacters}
          aria-label="Source title"
          placeholder={isPrimary ? 'Source material' : 'Untitled source'}
          onChange={(event) => onTitleChange(event.target.value)}
        />
        <div className={styles.paneActions}>
          {!isPrimary && (
            <Button
              variant="ghost"
              onClick={onMakePrimary}
              title="Use this source as the interview's backbone"
            >
              <Icon name="star" size={14} /> Make primary
            </Button>
          )}
          <Button variant="ghost" onClick={onDuplicate} aria-label="Duplicate source">
            <Icon name="copy" size={14} />
          </Button>
          <Button
            variant="ghost"
            className={styles.iconDanger}
            onClick={onDelete}
            disabled={!canDelete}
            aria-label="Delete source"
            title={canDelete ? 'Delete this source' : 'A project keeps at least one source'}
          >
            <Icon name="trash" size={14} />
          </Button>
        </div>
      </div>

      <div className={styles.paneMeta}>
        <span className={styles.metaRole}>
          {isPrimary && <Icon name="starFilled" size={13} className={styles.metaStar} />}
          {isPrimary ? 'Primary source' : 'Reference source'}
        </span>
        {draft.originalFilename && (
          <span className={styles.metaFile}>Imported from {draft.originalFilename}</span>
        )}
        <span className={overLimit ? styles.metaCharsOver : styles.metaChars}>
          {characters.toLocaleString()} / {PROJECT_SOURCE_LIMITS.maxCharactersPerDocument.toLocaleString()} chars
        </span>
      </div>

      {overLimit && (
        <p className={styles.paneWarning} role="alert">
          This source is over the {PROJECT_SOURCE_LIMITS.maxCharactersPerDocument.toLocaleString()}-character
          limit. Trim it before preparing the interview.
        </p>
      )}

      <MarkdownEditor
        key={draft.key}
        value={draft.content}
        onChange={onContentChange}
        ariaLabel={`Editing source: ${draft.title || 'Untitled source'}`}
        minHeight="320px"
        placeholder={
          isPrimary
            ? 'Paste or write the main material the interview draws on…'
            : 'Supporting context Mira can draw on…'
        }
      />
    </div>
  );
}
