import type {
  SessionCoverageItem,
  InterviewTurn,
  ModerationRecord,
} from '@shared/domain';
import type { RecentTurnContext } from '@shared/contracts';

/** Map live coverage into the compact shape the runtime model receives. */
export function buildCoverageContext(
  coverage: SessionCoverageItem[],
): Array<{
  coverageItemId: string;
  label: string;
  objective: string;
  priority: string;
  status: string;
  followUpCount: number;
}> {
  return coverage.map((c) => ({
    coverageItemId: c.id,
    label: c.label,
    objective: c.objective,
    priority: c.priority,
    status: c.status,
    followUpCount: c.followUpCount,
  }));
}

/** Map the most-recent completed turns into cleaned question/answer context. */
export function buildRecentTurns(turns: InterviewTurn[], limit: number): RecentTurnContext[] {
  return turns
    .filter((t) => t.answer != null)
    .slice(-limit)
    .map((t) => {
      const answer = t.answer!;
      const text =
        answer.userEditedTranscript?.trim() ||
        answer.cleanedTranscript?.trim() ||
        answer.rawTranscript.trim();
      return {
        turnId: t.id,
        question: t.question.text,
        answer: text,
        targetCoverageIds: t.question.targetCoverageItemIds,
      };
    });
}

/**
 * Translate a moderation result into a short, non-graphic instruction for the
 * interviewer model (spec §16.20). Never leaks provider category internals to
 * the stage.
 */
export function buildModerationGuidance(moderation: ModerationRecord | null): string {
  if (!moderation || moderation.decision === 'allow') {
    return 'No safety concerns. Proceed normally.';
  }
  if (moderation.decision === 'allow_sensitive') {
    return 'Topic is sensitive but allowed. Stay neutral and avoid escalating; do not editorialize.';
  }
  if (moderation.decision === 'redirect') {
    return 'Content requires redirection. Do not ask an enabling follow-up; move to a safe, high-level question or transition.';
  }
  return 'Moderation was unavailable. Default to a cautious, neutral question.';
}
