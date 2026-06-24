/**
 * Pure derivation of display + validation stats for the Project Asset Library.
 *
 * One source of truth for the renderer's per-source character counts and
 * save/prepare gating. Content size and reference count are uncapped — the
 * operator supplies their own material — so the only remaining {@link
 * SourceLibraryBlocker} mirrors the per-field title-length rule the Zod schema
 * still enforces, letting the UI disable a save the schema would reject and
 * explain why rather than round-tripping to a thrown error.
 */
import { PROJECT_SOURCE_LIMITS } from './constants/project-source-limits';
import type { SourceDraft } from './project-source-draft';

/** Per-source derived facts used by the list row and the editor pane. */
export interface SourceDocumentStat {
  key: string;
  characters: number;
  /** Title exceeds the max title length. */
  titleTooLong: boolean;
  /** Content is empty once trimmed. */
  empty: boolean;
}

export type SourceBlockerCode = 'title_too_long';

/** A hard problem that makes the library unsaveable. */
export interface SourceLibraryBlocker {
  code: SourceBlockerCode;
  message: string;
}

export interface SourceLibraryStats {
  documentCount: number;
  totalCharacters: number;
  perDocument: SourceDocumentStat[];
  /** At least one source has content (required to prepare, not to save). */
  hasContent: boolean;
  /** Empty ⇒ the library can be saved as-is. */
  blockers: SourceLibraryBlocker[];
}

export function computeSourceLibraryStats(drafts: SourceDraft[]): SourceLibraryStats {
  const limits = PROJECT_SOURCE_LIMITS;

  const perDocument = drafts.map<SourceDocumentStat>((draft) => ({
    key: draft.key,
    characters: draft.content.length,
    titleTooLong: draft.title.trim().length > limits.maxTitleCharacters,
    empty: draft.content.trim().length === 0,
  }));

  const totalCharacters = perDocument.reduce((sum, stat) => sum + stat.characters, 0);
  const documentCount = drafts.length;

  const blockers: SourceLibraryBlocker[] = [];
  if (perDocument.some((stat) => stat.titleTooLong)) {
    blockers.push({
      code: 'title_too_long',
      message: `A source title may be at most ${limits.maxTitleCharacters} characters.`,
    });
  }

  return {
    documentCount,
    totalCharacters,
    perDocument,
    hasContent: perDocument.some((stat) => !stat.empty),
    blockers,
  };
}

/** Whether the library can be saved (no schema-violating conditions). */
export function canSaveSources(stats: SourceLibraryStats): boolean {
  return stats.blockers.length === 0;
}
