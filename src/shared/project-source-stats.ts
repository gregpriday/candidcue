/**
 * Pure derivation of display + validation stats for the Project Asset Library.
 *
 * One source of truth for the renderer's budget meter, per-source character
 * counts, and save/prepare gating. The {@link SourceLibraryBlocker}s mirror the
 * cross-document rules in `validateProjectSourceInvariants` (and the per-field
 * Zod limits) so the UI can disable a save that the schema would reject anyway
 * and explain exactly why, rather than round-tripping to a thrown error.
 */
import { PROJECT_SOURCE_LIMITS } from './constants/project-source-limits';
import type { SourceDraft } from './project-source-draft';

export type SourceBudgetLevel = 'ok' | 'approaching' | 'over';

/** Per-source derived facts used by the list row and the editor pane. */
export interface SourceDocumentStat {
  key: string;
  characters: number;
  /** Content exceeds the per-document character cap. */
  overCharacterLimit: boolean;
  /** Title exceeds the max title length. */
  titleTooLong: boolean;
  /** Content is empty once trimmed. */
  empty: boolean;
}

export type SourceBlockerCode =
  | 'document_over_limit'
  | 'total_over_limit'
  | 'too_many_documents'
  | 'title_too_long';

/** A hard problem that makes the library unsaveable. */
export interface SourceLibraryBlocker {
  code: SourceBlockerCode;
  message: string;
}

export interface SourceLibraryStats {
  documentCount: number;
  totalCharacters: number;
  /** Headroom before the aggregate cap; clamped at 0 once over. */
  remainingCharacters: number;
  budget: SourceBudgetLevel;
  /** At or above the document count cap — adding/importing is disabled. */
  atDocumentLimit: boolean;
  perDocument: SourceDocumentStat[];
  /** The primary source has no content yet (blocks prepare, not save). */
  primaryEmpty: boolean;
  /** Empty ⇒ the library can be saved as-is. */
  blockers: SourceLibraryBlocker[];
}

export function computeSourceLibraryStats(drafts: SourceDraft[]): SourceLibraryStats {
  const limits = PROJECT_SOURCE_LIMITS;

  const perDocument = drafts.map<SourceDocumentStat>((draft) => ({
    key: draft.key,
    characters: draft.content.length,
    overCharacterLimit: draft.content.length > limits.maxCharactersPerDocument,
    titleTooLong: draft.title.trim().length > limits.maxTitleCharacters,
    empty: draft.content.trim().length === 0,
  }));

  const totalCharacters = perDocument.reduce((sum, stat) => sum + stat.characters, 0);
  const documentCount = drafts.length;

  let budget: SourceBudgetLevel = 'ok';
  if (totalCharacters > limits.maxTotalCharacters) {
    budget = 'over';
  } else if (totalCharacters >= limits.softWarningTotalCharacters) {
    budget = 'approaching';
  }

  const blockers: SourceLibraryBlocker[] = [];
  const overLimitCount = perDocument.filter((stat) => stat.overCharacterLimit).length;
  if (overLimitCount > 0) {
    blockers.push({
      code: 'document_over_limit',
      message:
        overLimitCount === 1
          ? `One source exceeds the ${limits.maxCharactersPerDocument.toLocaleString()}-character limit.`
          : `${overLimitCount} sources exceed the ${limits.maxCharactersPerDocument.toLocaleString()}-character limit.`,
    });
  }
  if (totalCharacters > limits.maxTotalCharacters) {
    blockers.push({
      code: 'total_over_limit',
      message: `Total source content exceeds the ${limits.maxTotalCharacters.toLocaleString()}-character limit.`,
    });
  }
  if (documentCount > limits.maxDocuments) {
    blockers.push({
      code: 'too_many_documents',
      message: `A project can hold at most ${limits.maxDocuments} sources.`,
    });
  }
  if (perDocument.some((stat) => stat.titleTooLong)) {
    blockers.push({
      code: 'title_too_long',
      message: `A source title may be at most ${limits.maxTitleCharacters} characters.`,
    });
  }

  return {
    documentCount,
    totalCharacters,
    remainingCharacters: Math.max(0, limits.maxTotalCharacters - totalCharacters),
    budget,
    atDocumentLimit: documentCount >= limits.maxDocuments,
    perDocument,
    primaryEmpty: perDocument[0]?.empty ?? true,
    blockers,
  };
}

/** Whether the library can be saved (no schema-violating conditions). */
export function canSaveSources(stats: SourceLibraryStats): boolean {
  return stats.blockers.length === 0;
}
