import { useCallback, useMemo, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { SourceList, type SourceListItem } from './SourceList';
import { SourceEditorPane } from './SourceEditorPane';
import { describeError } from '../lib/errors';
import { nextDraftKey } from '../lib/draft-key';
import {
  addBlankSource,
  addImportedSources,
  duplicateSource,
  moveSourceToIndex,
  removeSource,
  renameSource,
  updateSourceContent,
  type SourceDraft,
} from '@shared/project-source-draft';
import { computeSourceLibraryStats } from '@shared/project-source-stats';
import type { MarkdownImportFailure } from '@shared/domain';
import styles from './SourceLibrary.module.css';

interface SourceLibraryProps {
  drafts: SourceDraft[];
  onChange: (drafts: SourceDraft[]) => void;
  /** Surface a fatal import error through the parent's error channel. */
  onImportError?: (message: string) => void;
}

/**
 * The Project Asset Library workspace: a two-pane managed Markdown source library
 * (searchable/reorderable list + single editor pane) wired to the multi-file
 * native importer. Owns only ephemeral UI state (selection, search, import
 * status); every durable mutation flows through the pure draft model up to the
 * parent via {@link SourceLibraryProps.onChange}.
 */
export function SourceLibrary({ drafts, onChange, onImportError }: SourceLibraryProps): JSX.Element {
  const [selectedKey, setSelectedKey] = useState<string | null>(drafts[0]?.key ?? null);
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const [importFailures, setImportFailures] = useState<MarkdownImportFailure[]>([]);

  const stats = useMemo(() => computeSourceLibraryStats(drafts), [drafts]);
  const statByKey = useMemo(
    () => new Map(stats.perDocument.map((stat) => [stat.key, stat])),
    [stats],
  );

  // Selection always resolves to a live source; the parent may replace the list
  // wholesale (load/save), orphaning a stale key.
  const selectedDraft = drafts.find((draft) => draft.key === selectedKey) ?? drafts[0] ?? null;

  const items = useMemo<SourceListItem[]>(
    () =>
      drafts.map((draft) => {
        const stat = statByKey.get(draft.key);
        return {
          key: draft.key,
          title: draft.title,
          characters: stat?.characters ?? draft.content.length,
          empty: stat?.empty ?? draft.content.trim().length === 0,
        };
      }),
    [drafts, statByKey],
  );

  const updateContent = useCallback(
    (key: string, content: string) => onChange(updateSourceContent(drafts, key, content)),
    [drafts, onChange],
  );
  const rename = useCallback(
    (key: string, title: string) => onChange(renameSource(drafts, key, title)),
    [drafts, onChange],
  );
  const reorder = useCallback(
    (key: string, targetIndex: number) => onChange(moveSourceToIndex(drafts, key, targetIndex)),
    [drafts, onChange],
  );
  const addBlank = useCallback(() => {
    const { drafts: next, addedKey } = addBlankSource(drafts, nextDraftKey);
    onChange(next);
    setSelectedKey(addedKey);
  }, [drafts, onChange]);
  const duplicate = useCallback(
    (key: string) => {
      const { drafts: next, addedKey } = duplicateSource(drafts, key, nextDraftKey);
      onChange(next);
      if (addedKey) {
        setSelectedKey(addedKey);
      }
    },
    [drafts, onChange],
  );
  const remove = useCallback(
    (key: string) => {
      const { drafts: next, selectedKey: nextSelected } = removeSource(drafts, key, nextDraftKey);
      onChange(next);
      setSelectedKey(nextSelected);
    },
    [drafts, onChange],
  );

  const importFiles = useCallback(async () => {
    setImporting(true);
    setImportFailures([]);
    try {
      const result = await window.candidcue.projects.importMarkdownDocuments();
      if (result === null) {
        return; // dialog cancelled
      }
      if (result.documents.length > 0) {
        const { drafts: next, addedKeys } = addImportedSources(drafts, result.documents, nextDraftKey);
        onChange(next);
        const firstAdded = addedKeys[0];
        if (firstAdded) {
          setSelectedKey(firstAdded);
        }
      }
      setImportFailures(result.failures);
    } catch (err: unknown) {
      onImportError?.(describeError(err));
    } finally {
      setImporting(false);
    }
  }, [drafts, onChange, onImportError]);

  const dismissImportResult = useCallback(() => {
    setImportFailures([]);
  }, []);

  const hasImportResult = importFailures.length > 0;

  return (
    <section className={styles.library}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarCopy}>
          <h2>Reference material</h2>
          <p className={styles.toolbarHint}>
            The sources Mira can draw on — add as many as you like, in any order.
          </p>
        </div>
        <div className={styles.toolbarActions}>
          <Button variant="secondary" onClick={addBlank} title="Add a blank source">
            <Icon name="plus" size={15} /> Add source
          </Button>
          <Button
            variant="ghost"
            onClick={() => void importFiles()}
            disabled={importing}
            title="Import Markdown files"
          >
            <Icon name="upload" size={15} /> {importing ? 'Importing…' : 'Import Markdown'}
          </Button>
        </div>
      </div>

      {hasImportResult && (
        <div className={styles.importResult} role="status">
          <div className={styles.importResultBody}>
            {importFailures.length > 0 && (
              <>
                <strong>
                  {importFailures.length} file{importFailures.length === 1 ? '' : 's'} could not be
                  imported:
                </strong>
                <ul className={styles.failureList}>
                  {importFailures.map((failure) => (
                    <li key={failure.filename}>
                      <span className={styles.failureName}>{failure.filename}</span> — {failure.message}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <button
            type="button"
            className={styles.dismiss}
            onClick={dismissImportResult}
            aria-label="Dismiss import results"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      <div className={styles.workspace}>
        <SourceList
          items={items}
          selectedKey={selectedDraft?.key ?? null}
          query={query}
          onQueryChange={setQuery}
          onSelect={setSelectedKey}
          onReorder={reorder}
          totalCharacters={stats.totalCharacters}
          documentCount={stats.documentCount}
        />
        <SourceEditorPane
          draft={selectedDraft}
          stat={selectedDraft ? statByKey.get(selectedDraft.key) ?? null : null}
          canDelete={drafts.length > 1}
          onTitleChange={(title) => selectedDraft && rename(selectedDraft.key, title)}
          onContentChange={(content) => selectedDraft && updateContent(selectedDraft.key, content)}
          onDuplicate={() => selectedDraft && duplicate(selectedDraft.key)}
          onDelete={() => selectedDraft && remove(selectedDraft.key)}
        />
      </div>
    </section>
  );
}
