import type { InterviewBrief, CoverageDelta } from '@shared/domain';
import type { QuestionType, QuestionSource } from '@shared/domain';
import type { EndpointMode } from '@shared/domain';
import type { EndpointReason } from '@shared/domain';

/**
 * The display name of the (currently sole) interviewer character. Surfaced in
 * the markdown export so transcripts read naturally without leaking internal
 * character ids. See the character registry (`mira`).
 */
export const INTERVIEWER_DISPLAY_NAME = 'Mira';

/** Sentinel used when a turn has no usable answer text. */
const NO_ANSWER_PLACEHOLDER = '(no answer)';

/**
 * The subset of a session needed to render either export format. This is a
 * deliberately narrow, presentation-oriented projection: it carries only what
 * the markdown and JSON exporters consume and intentionally excludes
 * credentials, raw audio, absolute paths, and internal prompt material
 * (spec §30). Callers assemble it from the persisted `SessionAggregate` plus
 * project metadata.
 */
export interface SessionExportInput {
  /** Project title, used as the document heading. */
  projectTitle: string;
  /** Content hash of the compiled source the plan was built from. */
  sourceHash: string;
  /** The interview plan / brief in effect for the session. */
  brief: InterviewBrief;
  session: {
    id: string;
    characterId: string;
    startedAt: string | null;
    endedAt: string | null;
    endpointMode: EndpointMode;
    rollingSummary: string;
  };
  turns: Array<{
    ordinal: number;
    /** When the turn (question) was created. ISO 8601. */
    createdAt: string;
    /** When the turn was completed, or null if it never finished. ISO 8601. */
    completedAt: string | null;
    question: {
      text: string;
      type: QuestionType;
      targetCoverageItemIds: string[];
      source: QuestionSource;
    };
    answer: {
      rawTranscript: string;
      cleanedTranscript: string;
      userEditedTranscript: string | null;
      endpointReason: EndpointReason;
      /** When the founder started speaking the answer. ISO 8601, or null. */
      speechStartedAt: string | null;
      /** When the founder stopped speaking the answer. ISO 8601, or null. */
      speechEndedAt: string | null;
      /** Measured spoken duration of the answer in milliseconds, or null. */
      durationMs: number | null;
    } | null;
    coverageDelta: CoverageDelta[];
  }>;
  /** Coverage roll-up: human label plus final status string. */
  coverage: Array<{ label: string; status: string }>;
  /** Pre-formatted human duration label (e.g. "12m 30s"). */
  durationLabel: string;
  /** Pre-formatted human date the caller wishes to stamp on the document. */
  date: string;
}

type ExportTurn = SessionExportInput['turns'][number];

// ---------------------------------------------------------------------------
// Timecode / duration helpers (spec §30, issue #49)
//
// Exports carry no video — the footage lives on the founder's external camera.
// To let an editor conform the transcript against that recording, each turn is
// stamped with an offset from session start (when the founder began speaking),
// and the session/turn durations are rendered for real instead of `—`.
// ---------------------------------------------------------------------------

/**
 * Milliseconds from session start to when the founder began speaking a given
 * answer — the canonical anchor an editor uses to seek the external recording.
 * Returns null when either timestamp is absent or unparseable. The result is
 * clamped to be non-negative: clock skew can place `speechStartedAt` a hair
 * before `startedAt`, but a negative seek offset is meaningless. The raw ISO
 * timestamps are preserved separately (JSON export) so nothing is lost.
 */
export function computeOffsetFromStartMs(
  sessionStartedAt: string | null,
  speechStartedAt: string | null,
): number | null {
  if (sessionStartedAt === null || speechStartedAt === null) {
    return null;
  }
  const start = Date.parse(sessionStartedAt);
  const speech = Date.parse(speechStartedAt);
  if (Number.isNaN(start) || Number.isNaN(speech)) {
    return null;
  }
  return Math.max(0, speech - start);
}

/**
 * Format a millisecond duration as a coarse human label: `8s`, `12m 30s`, or
 * `1h 05m 03s`. Second granularity is deliberate — editors scrub by eye, so
 * sub-second precision is noise. Negative input is clamped to zero.
 */
function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return `${hours}h ${mm}m ${ss}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Format an offset (ms from session start) as a seek timecode: `M:SS` under an
 * hour, `H:MM:SS` beyond. This is what an editor types into a "go to timecode"
 * box or scrubs to against the clip's own elapsed counter. Negative input is
 * clamped to `0:00`.
 */
export function formatTimecodeOffset(offsetMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(offsetMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    const mm = String(minutes).padStart(2, '0');
    return `${hours}:${mm}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

/**
 * Compute the human session-duration label from the session's start/end
 * timestamps. Falls back to `—` when either timestamp is missing or
 * unparseable (e.g. a session that never properly ended).
 */
export function computeSessionDurationLabel(
  startedAt: string | null,
  endedAt: string | null,
): string {
  if (startedAt === null || endedAt === null) {
    return '—';
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return '—';
  }
  return formatDurationMs(end - start);
}

/**
 * Resolve the answer text for a turn using the documented precedence
 * (spec §30.1): a user edit wins over the model-cleaned transcript, which wins
 * over the raw STT transcript. A turn with no answer at all yields the
 * placeholder.
 */
export function resolveAnswerText(turn: ExportTurn): string {
  const answer = turn.answer;
  if (answer === null) {
    return NO_ANSWER_PLACEHOLDER;
  }
  // A user edit still wins outright (an intentional empty edit redacts the
  // answer, so keep `??` there). But a present-but-empty cleaned transcript must
  // fall through to the raw transcript — raw-only answers (END_NOW / recovery
  // durability checkpoints) carry `cleanedTranscript: ''`, and `??` would
  // otherwise render them blank even though the raw speech was captured (#74).
  return (
    answer.userEditedTranscript ??
    (answer.cleanedTranscript || answer.rawTranscript || NO_ANSWER_PLACEHOLDER)
  );
}

/**
 * A turn is considered incomplete (and is annotated as such) when it has no
 * answer, when its answer was salvaged from buffered audio after an interruption
 * (endpoint reason `recovery`), or when it was flushed by an operator END_NOW
 * abort (endpoint reason `ended-now`). Reviewers need to know these turns may be
 * partial.
 */
export function isIncompleteTurn(turn: ExportTurn): boolean {
  if (turn.answer === null) {
    return true;
  }
  return (
    turn.answer.endpointReason === 'recovery' || turn.answer.endpointReason === 'ended-now'
  );
}

/**
 * Count of turns that produced a usable answer, used in the metadata header.
 */
function countCompletedQuestions(turns: readonly ExportTurn[]): number {
  return turns.reduce((acc, turn) => (turn.answer !== null ? acc + 1 : acc), 0);
}

/**
 * Render a single turn block. The heading combines the ordinal with the
 * question type (a stable, human-readable "section" label) and, when timing is
 * available, a seek timecode plus spoken duration, e.g.
 * `## 3. clarification [2:15] (8s)`. The `[2:15]` is the offset from session
 * start to when the founder began speaking — an editor's anchor into the
 * external recording — and `(8s)` is how long the answer ran. Recovered or
 * unanswered turns get an inline note.
 */
function renderTurnBlock(turn: ExportTurn, sessionStartedAt: string | null): string {
  const lines: string[] = [];
  let heading = `## ${turn.ordinal}. ${turn.question.type}`;
  const offsetMs = turn.answer
    ? computeOffsetFromStartMs(sessionStartedAt, turn.answer.speechStartedAt)
    : null;
  if (offsetMs !== null) {
    heading += ` [${formatTimecodeOffset(offsetMs)}]`;
  }
  const durationMs = turn.answer?.durationMs ?? null;
  if (durationMs !== null && durationMs >= 0) {
    heading += ` (${formatDurationMs(durationMs)})`;
  }
  lines.push(heading);
  if (isIncompleteTurn(turn)) {
    lines.push('');
    lines.push('> _Note: this turn was incomplete or recovered; the answer may be partial._');
  }
  lines.push('');
  lines.push(`**${INTERVIEWER_DISPLAY_NAME}:** ${turn.question.text}`);
  lines.push('');
  lines.push('**Answer:**');
  lines.push('');
  lines.push(resolveAnswerText(turn));
  return lines.join('\n');
}

/**
 * Map a coverage status to a GitHub-style checklist marker. Only `covered`
 * counts as done; everything else (not started, partial, skipped, unknown)
 * renders as unchecked.
 */
function coverageCheckbox(status: string): string {
  return status === 'covered' ? '[x]' : '[ ]';
}

/**
 * Build a portable, human-readable Markdown transcript of a completed
 * interview session (spec §30.1). The output is self-contained: a title
 * heading, a metadata bullet list, one section per turn, and a coverage
 * checklist. It contains no credentials, audio, or internal prompt material.
 */
export function buildMarkdownExport(input: SessionExportInput): string {
  const blocks: string[] = [];

  // Title heading.
  blocks.push(`# ${input.projectTitle}`);

  // Metadata bullets.
  const metadata: string[] = [
    `- **Date:** ${input.date}`,
    `- **Interviewer:** ${INTERVIEWER_DISPLAY_NAME}`,
    `- **Duration:** ${input.durationLabel}`,
    `- **Questions completed:** ${countCompletedQuestions(input.turns)} of ${input.turns.length}`,
  ];
  blocks.push(metadata.join('\n'));

  // One block per turn, in ordinal order as supplied by the caller. Each turn's
  // seek timecode is computed relative to the session start.
  for (const turn of input.turns) {
    blocks.push(renderTurnBlock(turn, input.session.startedAt));
  }

  // Coverage checklist.
  const coverageLines: string[] = ['## Coverage'];
  coverageLines.push('');
  if (input.coverage.length === 0) {
    coverageLines.push('_No coverage items._');
  } else {
    for (const item of input.coverage) {
      coverageLines.push(`- ${coverageCheckbox(item.status)} ${item.label}`);
    }
  }
  blocks.push(coverageLines.join('\n'));

  // Blocks are separated by a blank line; a trailing newline keeps the file
  // POSIX-friendly.
  return `${blocks.join('\n\n')}\n`;
}
