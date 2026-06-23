import type { InterviewBrief, CoverageDelta } from '@shared/domain';
import type { QuestionType, QuestionSource } from '@shared/domain';
import type { EndpointMode, EndpointReason } from '@shared/domain';
import type { SessionExportInput } from './markdown-export';

/** Current version of the portable export envelope (spec §30.2). */
export const PORTABLE_EXPORT_SCHEMA_VERSION = 1;

/**
 * The question fields preserved in a portable export. This is exactly the
 * `Pick(text, type, targetCoverageItemIds, source)` projection mandated by
 * spec §30.2 — model ids, prompt versions, latencies, TTS details, and media
 * plans are deliberately omitted.
 */
export interface PortableQuestion {
  text: string;
  type: QuestionType;
  targetCoverageItemIds: string[];
  source: QuestionSource;
}

/**
 * The answer subset preserved in a portable export. Raw audio, provider ids,
 * moderation records, latencies, and timing metadata are intentionally
 * excluded; only transcripts and the reason the turn ended are carried.
 */
export interface PortableAnswer {
  rawTranscript: string;
  cleanedTranscript: string;
  userEditedTranscript: string | null;
  endpointReason: EndpointReason;
}

/** A single turn in the portable export. */
export interface PortableTurn {
  ordinal: number;
  question: PortableQuestion;
  answer: PortableAnswer | null;
  coverageDelta: CoverageDelta[];
}

/** Session-level metadata in the portable export (no device or credential data). */
export interface PortableSession {
  id: string;
  characterId: string;
  startedAt: string | null;
  endedAt: string | null;
  endpointMode: EndpointMode;
  rollingSummary: string;
}

/** Project-level metadata in the portable export, including the full plan. */
export interface PortableProject {
  title: string;
  sourceHash: string;
  plan: InterviewBrief;
}

/**
 * The complete machine-readable export envelope (spec §30.2). Versioned so
 * future readers can migrate, and scrubbed of anything sensitive: it carries
 * no API credentials, raw audio, absolute filesystem paths, or internal system
 * prompts.
 */
export interface PortableSessionExport {
  schemaVersion: typeof PORTABLE_EXPORT_SCHEMA_VERSION;
  /** Timestamp the caller chose to stamp on the export. */
  exportedAt: string;
  project: PortableProject;
  session: PortableSession;
  turns: PortableTurn[];
}

/**
 * Project the export-input answer onto the portable answer subset. Returns
 * `null` for unanswered turns. Only the four documented fields survive.
 */
function toPortableAnswer(
  answer: SessionExportInput['turns'][number]['answer'],
): PortableAnswer | null {
  if (answer === null) {
    return null;
  }
  return {
    rawTranscript: answer.rawTranscript,
    cleanedTranscript: answer.cleanedTranscript,
    userEditedTranscript: answer.userEditedTranscript,
    endpointReason: answer.endpointReason,
  };
}

/**
 * Build the portable JSON export for a session (spec §30.2). The shape is a
 * versioned envelope safe to share or re-import: every field is an explicit,
 * scrubbed projection of the input — there is no spread of the source objects,
 * so nothing sensitive can leak through accidentally.
 */
export function buildJsonExport(input: SessionExportInput): PortableSessionExport {
  return {
    schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
    exportedAt: input.date,
    project: {
      title: input.projectTitle,
      sourceHash: input.sourceHash,
      plan: input.brief,
    },
    session: {
      id: input.session.id,
      characterId: input.session.characterId,
      startedAt: input.session.startedAt,
      endedAt: input.session.endedAt,
      endpointMode: input.session.endpointMode,
      rollingSummary: input.session.rollingSummary,
    },
    turns: input.turns.map((turn) => ({
      ordinal: turn.ordinal,
      question: {
        text: turn.question.text,
        type: turn.question.type,
        targetCoverageItemIds: turn.question.targetCoverageItemIds,
        source: turn.question.source,
      },
      answer: toPortableAnswer(turn.answer),
      coverageDelta: turn.coverageDelta,
    })),
  };
}
