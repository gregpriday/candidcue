/**
 * Pure, framework-agnostic draft model for the Project Asset Library ("Sources").
 *
 * The renderer edits an ordered array of {@link SourceDraft}s; this module owns
 * every transition (rename, reorder, make-primary, duplicate, remove, import).
 * The list's array order **is** the persisted sort order and index 0 is always
 * the single primary, so the cross-document save invariants enforced by
 * `validateProjectSourceInvariants` (exactly one primary, primary at sortOrder 0,
 * dense 0..n-1 order) hold by construction — the UI cannot build an invalid list.
 *
 * No React, DOM, randomness, or clock access: key generation is injected so the
 * transitions stay deterministic and unit-testable.
 */
import { PROJECT_SOURCE_LIMITS } from './constants/project-source-limits';
import type {
  DocumentKind,
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
  kind: DocumentKind;
  title: string;
  originalFilename: string | null;
  mimeType: DocumentMime;
  content: string;
}

/** Injected key generator — deterministic in tests, unique-per-call in the app. */
export type KeyFactory = () => string;

const DEFAULT_PRIMARY_TITLE = 'Source material';
const DEFAULT_REFERENCE_TITLE = 'Untitled source';

function clampTitle(title: string): string {
  return title.length > PROJECT_SOURCE_LIMITS.maxTitleCharacters
    ? title.slice(0, PROJECT_SOURCE_LIMITS.maxTitleCharacters)
    : title;
}

function makeEmptyPrimary(newKey: KeyFactory): SourceDraft {
  return {
    key: newKey(),
    kind: 'primary',
    title: DEFAULT_PRIMARY_TITLE,
    originalFilename: null,
    mimeType: 'text/markdown',
    content: '',
  };
}

/** A fresh library: a single empty primary source. */
export function createSourceDrafts(newKey: KeyFactory): SourceDraft[] {
  return [makeEmptyPrimary(newKey)];
}

/**
 * Force the invariant shape: a non-empty list whose only primary sits at index 0.
 * Defensive — the database already guarantees this, but local edits route through
 * here so a malformed list can never reach {@link sourceDraftsToSaveInput}.
 */
export function normalizeSourceDrafts(drafts: SourceDraft[], newKey: KeyFactory): SourceDraft[] {
  if (drafts.length === 0) {
    return [makeEmptyPrimary(newKey)];
  }
  let primaryIndex = drafts.findIndex((draft) => draft.kind === 'primary');
  if (primaryIndex === -1) {
    primaryIndex = 0;
  }
  const found = drafts[primaryIndex];
  if (!found) {
    return [makeEmptyPrimary(newKey)];
  }
  const primary: SourceDraft = { ...found, kind: 'primary' };
  const rest = drafts
    .filter((_, index) => index !== primaryIndex)
    .map<SourceDraft>((draft) => (draft.kind === 'primary' ? { ...draft, kind: 'reference' } : draft));
  return [primary, ...rest];
}

/** Hydrate drafts from a loaded aggregate, sorted and normalized. */
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
      kind: doc.kind,
      title: doc.title,
      originalFilename: doc.originalFilename,
      mimeType: doc.mimeType,
      content: doc.content,
    }));
  return normalizeSourceDrafts(drafts, newKey);
}

/**
 * Project drafts to the save contract. The array index becomes both the dense
 * sortOrder and the primary/reference role, so the result always satisfies the
 * cross-document invariants regardless of any stale `kind` on a draft.
 */
export function sourceDraftsToSaveInput(drafts: SourceDraft[]): SaveProjectDocumentInput[] {
  return drafts.map((draft, index) => {
    const kind: DocumentKind = index === 0 ? 'primary' : 'reference';
    const fallbackTitle = index === 0 ? DEFAULT_PRIMARY_TITLE : DEFAULT_REFERENCE_TITLE;
    const base: SaveProjectDocumentInput = {
      kind,
      title: clampTitle(draft.title.trim() || fallbackTitle),
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

/** Append a blank reference source and return the key to select it by. */
export function addBlankSource(
  drafts: SourceDraft[],
  newKey: KeyFactory,
): { drafts: SourceDraft[]; addedKey: string } {
  const addedKey = newKey();
  const draft: SourceDraft = {
    key: addedKey,
    kind: 'reference',
    title: DEFAULT_REFERENCE_TITLE,
    originalFilename: null,
    mimeType: 'text/markdown',
    content: '',
  };
  return { drafts: [...drafts, draft], addedKey };
}

/** Append imported Markdown files as reference sources. */
export function addImportedSources(
  drafts: SourceDraft[],
  imported: ImportedMarkdownDocument[],
  newKey: KeyFactory,
): { drafts: SourceDraft[]; addedKeys: string[] } {
  const added = imported.map<SourceDraft>((file) => ({
    key: newKey(),
    kind: 'reference',
    title: clampTitle(file.title || file.originalFilename),
    originalFilename: file.originalFilename,
    mimeType: 'text/markdown',
    content: file.content,
  }));
  return { drafts: [...drafts, ...added], addedKeys: added.map((draft) => draft.key) };
}

/**
 * Promote a source to primary: it moves to index 0 and the previous primary is
 * demoted to a reference, keeping the relative order of the remaining sources.
 */
export function makeSourcePrimary(drafts: SourceDraft[], key: string): SourceDraft[] {
  const index = drafts.findIndex((draft) => draft.key === key);
  if (index <= 0) {
    return drafts; // not found, or already the primary at index 0
  }
  const source = drafts[index];
  if (!source) {
    return drafts;
  }
  const target: SourceDraft = { ...source, kind: 'primary' };
  const rest = drafts
    .filter((draft) => draft.key !== key)
    .map<SourceDraft>((draft) => ({ ...draft, kind: 'reference' }));
  return [target, ...rest];
}

/** Duplicate a source as a reference inserted directly after the original. */
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
    kind: 'reference',
    title: clampTitle(`${source.title} (copy)`),
    originalFilename: null,
    mimeType: source.mimeType,
    content: source.content,
  };
  const next = [...drafts.slice(0, index + 1), copy, ...drafts.slice(index + 1)];
  return { drafts: next, addedKey };
}

/**
 * Remove a source. If the primary is removed the next source is promoted; if the
 * last source is removed the library resets to a single empty primary. Returns
 * the key the UI should select next.
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
 * Move a reference source to a target slot. References occupy indices 1..n-1; the
 * target is clamped into that range so a reorder (button or drag) can never
 * displace the primary at index 0. The target index is interpreted against the
 * array after the source is lifted out.
 */
export function moveSourceToIndex(
  drafts: SourceDraft[],
  key: string,
  targetIndex: number,
): SourceDraft[] {
  const index = drafts.findIndex((draft) => draft.key === key);
  if (index <= 0) {
    return drafts; // primary (or not found) — not reorderable
  }
  const clamped = Math.min(Math.max(1, targetIndex), drafts.length - 1);
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

/**
 * Reorder a reference source one slot up or down. The primary is pinned at index
 * 0 and never participates, so reordering can never displace it.
 */
export function moveSource(drafts: SourceDraft[], key: string, delta: -1 | 1): SourceDraft[] {
  const index = drafts.findIndex((draft) => draft.key === key);
  if (index <= 0) {
    return drafts;
  }
  return moveSourceToIndex(drafts, key, index + delta);
}
