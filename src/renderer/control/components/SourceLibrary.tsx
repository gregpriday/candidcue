import { useCallback, useMemo, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { SourceList, type SourceListItem } from './SourceList';
import { SourceEditorPane } from './SourceEditorPane';
import { describeError } from '../lib/errors';
import { nextDraftKey } from '../lib/draft-key';
import { PROJECT_SOURCE_LIMITS } from '@shared/constants/project-source-limits';
import {
  addBlankSource,
  addImportedSources,
  duplicateSource,
  makeSourcePrimary,
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
  const [importNotice, setImportNotice] = useState<string | null>(null);

  const stats = useMemo(() => computeSourceLibraryStats(drafts), [drafts]);
  const statByKey = useMemo(
    () => new Map(stats.perDocument.map((stat) => [stat.key, stat])),
    [stats],
  );

  // Selection always resolves to a live source; the parent may replace the list
  // wholesale (load/save), orphaning a stale key.
  const selectedDraft = drafts.find((draft) => draft.key === selectedKey) ?? drafts[0] ?? null;
  const selectedIndex = selectedDraft
    ? drafts.findIndex((draft) => draft.key === selectedDraft.key)
    : -1;

  const items = useMemo<SourceListItem[]>(
    () =>
      drafts.map((draft, index) => {
        const stat = statByKey.get(draft.key);
        return {
          key: draft.key,
          title: draft.title,
          isPrimary: index === 0,
          characters: stat?.characters ?? draft.content.length,
          overLimit: stat?.overCharacterLimit ?? false,
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
  const makePrimary = useCallback(
    (key: string) => {
      onChange(makeSourcePrimary(drafts, key));
      setSelectedKey(key);
    },
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
    setImportNotice(null);
    try {
      const result = await window.candidcue.projects.importMarkdownDocuments();
      if (result === null) {
        return; // dialog cancelled
      }
      const remainingSlots = Math.max(0, PROJECT_SOURCE_LIMITS.maxDocuments - drafts.length);
      let toAdd = result.documents;
      let skipped = 0;
      if (toAdd.length > remainingSlots) {
        skipped = toAdd.length - remainingSlots;
        toAdd = toAdd.slice(0, remainingSlots);
      }
      if (toAdd.length > 0) {
        const { drafts: next, addedKeys } = addImportedSources(drafts, toAdd, nextDraftKey);
        onChange(next);
        const firstAdded = addedKeys[0];
        if (firstAdded) {
          setSelectedKey(firstAdded);
        }
      }
      setImportFailures(result.failures);
      if (skipped > 0) {
        setImportNotice(
          `${skipped} file(s) skipped — an interview can hold at most ${PROJECT_SOURCE_LIMITS.maxDocuments} references.`,
        );
      }
    } catch (err: unknown) {
      onImportError?.(describeError(err));
    } finally {
      setImporting(false);
    }
  }, [drafts, onChange, onImportError]);

  const dismissImportResult = useCallback(() => {
    setImportFailures([]);
    setImportNotice(null);
  }, []);

  const hasImportResult = importFailures.length > 0 || importNotice !== null;

  return (
    <section className={styles.library}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarCopy}>
          <h2>
            Reference material <span>· {stats.documentCount} of {PROJECT_SOURCE_LIMITS.maxDocuments}</span>
          </h2>
          <p className={styles.toolbarHint}>
            The main material and any supporting context Mira can draw on.
          </p>
        </div>
        <div className={styles.toolbarActions}>
          <Button
            variant="secondary"
            onClick={addBlank}
            disabled={stats.atDocumentLimit}
            title={stats.atDocumentLimit ? 'Reference limit reached' : 'Add a blank reference'}
          >
            <Icon name="plus" size={15} /> Add reference
          </Button>
          <Button
            variant="ghost"
            onClick={() => void importFiles()}
            disabled={stats.atDocumentLimit || importing}
            title={stats.atDocumentLimit ? 'Reference limit reached' : 'Import Markdown files'}
          >
            <Icon name="upload" size={15} /> {importing ? 'Importing…' : 'Import Markdown'}
          </Button>
        </div>
      </div>

      {hasImportResult && (
        <div className={styles.importResult} role="status">
          <div className={styles.importResultBody}>
            {importNotice && <p className={styles.importNotice}>{importNotice}</p>}
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
          onMakePrimary={makePrimary}
          onReorder={reorder}
          budget={stats.budget}
          totalCharacters={stats.totalCharacters}
          documentCount={stats.documentCount}
        />
        <SourceEditorPane
          draft={selectedDraft}
          stat={selectedDraft ? statByKey.get(selectedDraft.key) ?? null : null}
          isPrimary={selectedIndex === 0}
          canDelete={drafts.length > 1}
          onTitleChange={(title) => selectedDraft && rename(selectedDraft.key, title)}
          onContentChange={(content) => selectedDraft && updateContent(selectedDraft.key, content)}
          onMakePrimary={() => selectedDraft && makePrimary(selectedDraft.key)}
          onDuplicate={() => selectedDraft && duplicate(selectedDraft.key)}
          onDelete={() => selectedDraft && remove(selectedDraft.key)}
        />
      </div>
    </section>
  );
}
