import { useMemo } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { Icon } from './Icon';
import type { SourceBudgetLevel } from '@shared/project-source-stats';
import { PROJECT_SOURCE_LIMITS } from '@shared/constants/project-source-limits';
import styles from './SourceLibrary.module.css';

export interface SourceListItem {
  key: string;
  title: string;
  isPrimary: boolean;
  characters: number;
  overLimit: boolean;
  empty: boolean;
}

interface SourceListProps {
  items: SourceListItem[];
  selectedKey: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (key: string) => void;
  onMakePrimary: (key: string) => void;
  /** Move a reference to an absolute index (references occupy 1..n-1). */
  onReorder: (key: string, targetIndex: number) => void;
  budget: SourceBudgetLevel;
  totalCharacters: number;
  documentCount: number;
}

/**
 * The left rail of the Sources workspace: a searchable, reorderable listbox of
 * sources plus an aggregate budget footer. Presentational and CodeMirror-free so
 * it renders under jsdom — all state transitions are owned by the parent.
 */
export function SourceList({
  items,
  selectedKey,
  query,
  onQueryChange,
  onSelect,
  onMakePrimary,
  onReorder,
  budget,
  totalCharacters,
  documentCount,
}: SourceListProps): JSX.Element {
  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      normalizedQuery
        ? items.filter((item) => item.title.toLowerCase().includes(normalizedQuery))
        : items,
    [items, normalizedQuery],
  );

  const selectRelative = (event: KeyboardEvent<HTMLDivElement>, delta: 1 | -1): void => {
    event.preventDefault();
    if (visible.length === 0) {
      return;
    }
    const current = visible.findIndex((item) => item.key === selectedKey);
    const next = current === -1 ? 0 : Math.min(Math.max(0, current + delta), visible.length - 1);
    const target = visible[next];
    if (target) {
      onSelect(target.key);
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown') {
      selectRelative(event, 1);
    } else if (event.key === 'ArrowUp') {
      selectRelative(event, -1);
    }
  };

  const handleDrop = (event: DragEvent<HTMLLIElement>, targetIndex: number): void => {
    event.preventDefault();
    const draggedKey = event.dataTransfer.getData('text/plain');
    if (draggedKey) {
      onReorder(draggedKey, targetIndex);
    }
  };

  const budgetLabel = `${totalCharacters.toLocaleString()} / ${PROJECT_SOURCE_LIMITS.maxTotalCharacters.toLocaleString()}`;
  const budgetClass = [styles.budget, styles[`budget_${budget}`]].filter(Boolean).join(' ');

  return (
    <div className={styles.list}>
      <div className={styles.search}>
        <Icon name="search" size={14} />
        <input
          className={styles.searchInput}
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search sources…"
          aria-label="Search sources"
        />
      </div>

      <div
        className={styles.options}
        role="listbox"
        aria-label="Sources"
        tabIndex={0}
        onKeyDown={onListKeyDown}
      >
        {visible.length === 0 ? (
          <p className={styles.listEmpty}>No sources match “{query}”.</p>
        ) : (
          <ul className={styles.optionList}>
            {visible.map((item, position) => {
              const selected = item.key === selectedKey;
              const itemIndex = items.findIndex((entry) => entry.key === item.key);
              const rowClass = [styles.option, selected ? styles.optionSelected : '']
                .filter(Boolean)
                .join(' ');
              return (
                <li
                  key={item.key}
                  className={rowClass}
                  role="option"
                  aria-selected={selected}
                  draggable={!item.isPrimary}
                  onDragStart={(event) => event.dataTransfer.setData('text/plain', item.key)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => handleDrop(event, itemIndex)}
                  onClick={() => onSelect(item.key)}
                >
                  {item.isPrimary ? (
                    <span className={styles.primaryStar} title="Primary source" aria-label="Primary source">
                      <Icon name="starFilled" size={14} aria-hidden />
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={styles.makePrimary}
                      title="Make primary"
                      aria-label={`Make “${item.title}” the primary source`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onMakePrimary(item.key);
                      }}
                    >
                      <Icon name="star" size={14} />
                    </button>
                  )}

                  <span className={styles.optionBody}>
                    <span className={styles.optionTitle}>{item.title || 'Untitled source'}</span>
                    <span className={styles.optionMeta}>
                      {item.isPrimary && <span className={styles.primaryTag}>primary</span>}
                      <span className={item.overLimit ? styles.optionCharsOver : styles.optionChars}>
                        {item.characters.toLocaleString()} chars
                      </span>
                      {item.empty && <span className={styles.optionEmpty}>empty</span>}
                    </span>
                  </span>

                  {!item.isPrimary && (
                    <span className={styles.reorder}>
                      <button
                        type="button"
                        className={styles.reorderButton}
                        aria-label={`Move “${item.title}” up`}
                        disabled={position <= 1}
                        onClick={(event) => {
                          event.stopPropagation();
                          onReorder(item.key, itemIndex - 1);
                        }}
                      >
                        <Icon name="chevronDown" size={14} className={styles.reorderUp} />
                      </button>
                      <button
                        type="button"
                        className={styles.reorderButton}
                        aria-label={`Move “${item.title}” down`}
                        disabled={position === visible.length - 1}
                        onClick={(event) => {
                          event.stopPropagation();
                          onReorder(item.key, itemIndex + 1);
                        }}
                      >
                        <Icon name="chevronDown" size={14} />
                      </button>
                      <span className={styles.grip} aria-hidden title="Drag to reorder">
                        <Icon name="grip" size={14} />
                      </span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className={styles.footer}>
        <span className={styles.docCount}>
          {documentCount} / {PROJECT_SOURCE_LIMITS.maxDocuments} sources
        </span>
        <span className={budgetClass} title="Total source characters across the project">
          {budgetLabel}
        </span>
      </div>
    </div>
  );
}
