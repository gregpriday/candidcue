/**
 * Pure, framework-agnostic draft model for the Project Asset Library ("Sources").
 *
 * The renderer edits an ordered array of {@link SourceDraft}s; this module owns
 * every transition (rename, reorder, duplicate, remove, import). Sources are
 * equal, user-ordered peers — there is no primary — so the list's array order
 * **is** the persisted sort order. The cross-document save invariants enforced by
 * `validateProjectSourceInvariants` (unique ids, dense 0..n-1 order) hold by
 * construction: {@link sourceDraftsToSaveInput} stamps the sortOrder from the
 * array index, so the UI cannot build an invalid list.
 *
 * No React, DOM, randomness, or clock access: key generation is injected so the
 * transitions stay deterministic and unit-testable.
 */
import { PROJECT_SOURCE_LIMITS } from './constants/project-source-limits';
import type {
  DocumentMime,
  ImportedMarkdownDocument,
  ProjectAggregate,
  SaveProjectDocumentInput,
} from './domain';

/** A single editable source in the library. */
export interface SourceDraft {
  /** Persisted document id; absent for sources that have never been saved. */
  id?: string;
  /** Stable client-only key for React lists and selection (always present). */
  key: string;
  title: string;
  originalFilename: string | null;
  mimeType: DocumentMime;
  content: string;
}

/** Injected key generator — deterministic in tests, unique-per-call in the app. */
export type KeyFactory = () => string;

/** Title of the seed source a fresh library starts with. Not special otherwise. */
const DEFAULT_SEED_TITLE = 'Source material';
const DEFAULT_UNTITLED_TITLE = 'Untitled source';

function clampTitle(title: string): string {
  return title.length > PROJECT_SOURCE_LIMITS.maxTitleCharacters
    ? title.slice(0, PROJECT_SOURCE_LIMITS.maxTitleCharacters)
    : title;
}

function makeEmptySource(newKey: KeyFactory): SourceDraft {
  return {
    key: newKey(),
    title: DEFAULT_SEED_TITLE,
    originalFilename: null,
    mimeType: 'text/markdown',
    content: '',
  };
}

/** A fresh library: a single empty source titled "Source material". */
export function createSourceDrafts(newKey: KeyFactory): SourceDraft[] {
  return [makeEmptySource(newKey)];
}

/**
 * Force the invariant shape: a non-empty list. Defensive — a library always has
 * at least one source, so a wholesale edit that emptied the list resets to a
 * single seed source rather than letting an empty list reach the save contract.
 */
export function normalizeSourceDrafts(drafts: SourceDraft[], newKey: KeyFactory): SourceDraft[] {
  return drafts.length === 0 ? [makeEmptySource(newKey)] : drafts;
}

/** Hydrate drafts from a loaded aggregate, sorted by sort order. */
export function sourceDraftsFromAggregate(
  aggregate: ProjectAggregate,
  newKey: KeyFactory,
): SourceDraft[] {
  const drafts = aggregate.documents
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map<SourceDraft>((doc) => ({
      id: doc.id,
      key: newKey(),
      title: doc.title,
      originalFilename: doc.originalFilename,
      mimeType: doc.mimeType,
      content: doc.content,
    }));
  return normalizeSourceDrafts(drafts, newKey);
}

/**
 * Project drafts to the save contract. The array index becomes the dense
 * sortOrder, so the result always satisfies the cross-document invariants.
 */
export function sourceDraftsToSaveInput(drafts: SourceDraft[]): SaveProjectDocumentInput[] {
  return drafts.map((draft, index) => {
    const base: SaveProjectDocumentInput = {
      title: clampTitle(draft.title.trim() || DEFAULT_UNTITLED_TITLE),
      originalFilename: draft.originalFilename,
      mimeType: draft.mimeType,
      content: draft.content,
      sortOrder: index,
    };
    return draft.id ? { ...base, id: draft.id } : base;
  });
}

/** Replace one source's editor content. */
export function updateSourceContent(
  drafts: SourceDraft[],
  key: string,
  content: string,
): SourceDraft[] {
  return drafts.map((draft) => (draft.key === key ? { ...draft, content } : draft));
}

/** Rename one source (title is clamped to the max title length). */
export function renameSource(drafts: SourceDraft[], key: string, title: string): SourceDraft[] {
  return drafts.map((draft) => (draft.key === key ? { ...draft, title: clampTitle(title) } : draft));
}

/** Append a blank source and return the key to select it by. */
export function addBlankSource(
  drafts: SourceDraft[],
  newKey: KeyFactory,
): { drafts: SourceDraft[]; addedKey: string } {
  const addedKey = newKey();
  const draft: SourceDraft = {
    key: addedKey,
    title: DEFAULT_UNTITLED_TITLE,
    originalFilename: null,
    mimeType: 'text/markdown',
    content: '',
  };
  return { drafts: [...drafts, draft], addedKey };
}

/** Append imported Markdown files as sources. */
export function addImportedSources(
  drafts: SourceDraft[],
  imported: ImportedMarkdownDocument[],
  newKey: KeyFactory,
): { drafts: SourceDraft[]; addedKeys: string[] } {
  const added = imported.map<SourceDraft>((file) => ({
    key: newKey(),
    title: clampTitle(file.title || file.originalFilename),
    originalFilename: file.originalFilename,
    mimeType: 'text/markdown',
    content: file.content,
  }));
  return { drafts: [...drafts, ...added], addedKeys: added.map((draft) => draft.key) };
}

/** Duplicate a source as a copy inserted directly after the original. */
export function duplicateSource(
  drafts: SourceDraft[],
  key: string,
  newKey: KeyFactory,
): { drafts: SourceDraft[]; addedKey: string | null } {
  const index = drafts.findIndex((draft) => draft.key === key);
  const source = index === -1 ? undefined : drafts[index];
  if (!source) {
    return { drafts, addedKey: null };
  }
  const addedKey = newKey();
  const copy: SourceDraft = {
    key: addedKey,
    title: clampTitle(`${source.title} (copy)`),
    originalFilename: null,
    mimeType: source.mimeType,
    content: source.content,
  };
  const next = [...drafts.slice(0, index + 1), copy, ...drafts.slice(index + 1)];
  return { drafts: next, addedKey };
}

/**
 * Remove a source. If the last source is removed the library resets to a single
 * empty seed source. Returns the key the UI should select next (the prior
 * neighbor, falling back to the new first source).
 */
export function removeSource(
  drafts: SourceDraft[],
  key: string,
  newKey: KeyFactory,
): { drafts: SourceDraft[]; selectedKey: string } {
  const index = drafts.findIndex((draft) => draft.key === key);
  if (index === -1) {
    const normalized = normalizeSourceDrafts(drafts, newKey);
    return { drafts: normalized, selectedKey: normalized[0]?.key ?? '' };
  }
  const remaining = drafts.filter((draft) => draft.key !== key);
  const normalized = normalizeSourceDrafts(remaining, newKey); // guaranteed non-empty
  const selectIndex = Math.min(Math.max(0, index - 1), normalized.length - 1);
  const selected = normalized[selectIndex] ?? normalized[0];
  return { drafts: normalized, selectedKey: selected ? selected.key : '' };
}

/**
 * Move a source to a target slot. Any source can move to any position 0..n-1;
 * the target is clamped into range. The target index is interpreted against the
 * array after the source is lifted out.
 */
export function moveSourceToIndex(
  drafts: SourceDraft[],
  key: string,
  targetIndex: number,
): SourceDraft[] {
  const index = drafts.findIndex((draft) => draft.key === key);
  if (index < 0) {
    return drafts; // not found
  }
  const clamped = Math.min(Math.max(0, targetIndex), drafts.length - 1);
  if (clamped === index) {
    return drafts;
  }
  const next = drafts.slice();
  const [moved] = next.splice(index, 1);
  if (!moved) {
    return drafts;
  }
  next.splice(clamped, 0, moved);
  return next;
}

/** Reorder a source one slot up or down. */
export function moveSource(drafts: SourceDraft[], key: string, delta: -1 | 1): SourceDraft[] {
  const index = drafts.findIndex((draft) => draft.key === key);
  if (index < 0) {
    return drafts;
  }
  return moveSourceToIndex(drafts, key, index + delta);
}
