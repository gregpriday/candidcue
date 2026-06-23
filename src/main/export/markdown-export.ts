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
  return (
    answer.userEditedTranscript ??
    answer.cleanedTranscript ??
    answer.rawTranscript ??
    NO_ANSWER_PLACEHOLDER
  );
}

/**
 * A turn is considered incomplete (and is annotated as such) when it has no
 * answer, or when its answer was salvaged from buffered audio after an
 * interruption (endpoint reason `recovery`). Reviewers need to know these
 * turns may be partial.
 */
export function isIncompleteTurn(turn: ExportTurn): boolean {
  if (turn.answer === null) {
    return true;
  }
  return turn.answer.endpointReason === 'recovery';
}

/**
 * Count of turns that produced a usable answer, used in the metadata header.
 */
function countCompletedQuestions(turns: readonly ExportTurn[]): number {
  return turns.reduce((acc, turn) => (turn.answer !== null ? acc + 1 : acc), 0);
}

/**
 * Render a single turn block. The heading combines the ordinal with the
 * question type (a stable, human-readable "section" label), e.g.
 * `## 3. clarification`. Recovered or unanswered turns get an inline note.
 */
function renderTurnBlock(turn: ExportTurn): string {
  const lines: string[] = [];
  lines.push(`## ${turn.ordinal}. ${turn.question.type}`);
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

  // One block per turn, in ordinal order as supplied by the caller.
  for (const turn of input.turns) {
    blocks.push(renderTurnBlock(turn));
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
