/**
 * Plain-language copy for the smooth-following UI (companion §48, §49, §58–§62;
 * primary Appendix F.11–F.13 voice).
 *
 * Everything here is a pure function so the wording is unit-testable and the
 * store stays free of presentation strings. Two rules govern every phrase:
 *
 *  1. §3 experience contract — never imply certainty the tracker does not have.
 *     Confidence is reported as a coarse band, never a percentage, and pace is
 *     always approximate.
 *  2. Appendix F.13 — where a concrete failure is known, name it. Avoid
 *     "something went wrong" language.
 */
import type { TrackingBehavior, TrackingStateV2 } from '../../shared/contracts';
import type { MovementDecisionRecord as EngineMovementDecisionRecord } from '../../shared/tracking/decision-log';

/* ---------------------------------------------------------------------------
 * Tracking state (§48 "tracking state in plain language")
 * ------------------------------------------------------------------------- */

/**
 * One short status line per state. Wording reuses the primary F.11 vocabulary
 * ("Holding your place", "Looking for your place", "Reconnecting — position
 * held") so Live never speaks two dialects.
 */
export const FOLLOW_STATE_LABELS: Record<TrackingStateV2, string> = {
  acquiring: 'Looking for your place',
  following: 'Following',
  coasting: 'Keeping pace',
  uncertain: 'Unsure — slowing down',
  adlib_hold: 'Off script — holding your place',
  catching_up: 'Catching up',
  retake_pending: 'Retake detected',
  rewinding: 'Going back with you',
  reanchoring: 'Moving to your place',
  command_pending: 'Command heard',
  paused: 'Paused — still listening for “CandidCue, resume”',
  reconnecting: 'Reconnecting — position held',
  lost_local: 'Looking for your place',
};

/** A one-sentence explanation shown under the status line when it helps. */
export const FOLLOW_STATE_DETAIL: Record<TrackingStateV2, string | null> = {
  acquiring: 'Start speaking and the stage picks up your place.',
  following: null,
  coasting: 'Carrying your recent pace while it waits for the next words.',
  uncertain: 'Evidence is thin, so the text is slowing rather than guessing.',
  adlib_hold: 'The next scripted line stays put until you return to it.',
  catching_up: 'Absorbing a small correction by moving a little faster.',
  retake_pending: 'Collecting evidence that you restarted — nothing has moved yet.',
  rewinding: 'Reversing gently to where you restarted.',
  reanchoring: 'Moving straight to the destination instead of racing through the text.',
  command_pending: 'Holding while the command is checked.',
  paused: 'Automatic movement is stopped. Transcription is still connected.',
  reconnecting: 'Your place is held until transcription returns.',
  lost_local: 'No local match yet. The text stays where it is.',
};

/** Tone used for the state indicator — calm by default, never alarming. */
export type FollowStateTone = 'neutral' | 'accent' | 'success' | 'warning';

export function followStateTone(state: TrackingStateV2): FollowStateTone {
  switch (state) {
    case 'following':
    case 'catching_up':
      return 'success';
    case 'coasting':
    case 'reanchoring':
    case 'rewinding':
    case 'command_pending':
      return 'accent';
    case 'uncertain':
    case 'adlib_hold':
    case 'retake_pending':
    case 'reconnecting':
    case 'lost_local':
      return 'warning';
    default:
      return 'neutral';
  }
}

/* ---------------------------------------------------------------------------
 * Behavior (§52) — why the tracker thinks you moved
 * ------------------------------------------------------------------------- */

export const FOLLOW_BEHAVIOR_LABELS: Record<TrackingBehavior, string> = {
  acquire: 'Finding the opening line',
  normal: 'Reading as written',
  minor_variation: 'Small wording change',
  paraphrase: 'Paraphrasing this sentence',
  adlib: 'Speaking off script',
  return: 'Back on script',
  small_skip: 'Skipped a little ahead',
  large_skip: 'Jumped ahead in this section',
  retake_candidate: 'Possible retake',
  retake: 'Retake',
  manual_navigation: 'You moved it',
  command_navigation: 'A voice command moved it',
  lost: 'No match yet',
};

/* ---------------------------------------------------------------------------
 * Confidence (§48 "without implying false precision")
 * ------------------------------------------------------------------------- */

export type ConfidenceBand = 'unknown' | 'low' | 'unsure' | 'steady' | 'strong';

/** Ordered weakest → strongest; index doubles as the meter position. */
export const CONFIDENCE_BANDS: ConfidenceBand[] = ['low', 'unsure', 'steady', 'strong'];

export const CONFIDENCE_BAND_LABELS: Record<ConfidenceBand, string> = {
  unknown: 'No reading yet',
  low: 'Low',
  unsure: 'Unsure',
  steady: 'Steady',
  strong: 'Strong',
};

/**
 * Coarse banding. The thresholds only decide *wording*; no control-system
 * behavior depends on them, so they are display constants rather than profile
 * parameters.
 */
export function confidenceBand(confidence: number | null | undefined): ConfidenceBand {
  if (confidence === null || confidence === undefined || Number.isNaN(confidence)) return 'unknown';
  if (confidence >= 0.8) return 'strong';
  if (confidence >= 0.6) return 'steady';
  if (confidence >= 0.35) return 'unsure';
  return 'low';
}

/** 0-based meter position, or -1 when there is nothing to show. */
export function confidenceBandIndex(band: ConfidenceBand): number {
  return CONFIDENCE_BANDS.indexOf(band);
}

/** Approximate pace. Always hedged — the estimator is not a stopwatch. */
export function formatPace(wordsPerMinute: number | null): string {
  if (wordsPerMinute === null || !Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0) {
    return 'Pace not established yet';
  }
  return `≈ ${Math.round(wordsPerMinute / 5) * 5} words per minute`;
}

/* ---------------------------------------------------------------------------
 * Degraded operation (Part XI) — one honest state per condition
 * ------------------------------------------------------------------------- */

export type FollowNoticeId =
  /** §58 Luna timed out, errored, hit quota, or has no model access. */
  | 'luna_unavailable'
  /** §59 Realtime transcription interrupted. */
  | 'transcription_interrupted'
  /** §60 Missing or weak transcript confidence. */
  | 'low_transcript_confidence'
  /** §61 The stage keeps missing its frame budget. */
  | 'frame_performance'
  /** §62 Line measurement failed or is inconsistent. */
  | 'invalid_line_map'
  /** §63 A runtime budget was exceeded. */
  | 'budget_exceeded';

export type FollowNoticeTone = 'info' | 'warning' | 'danger';

export interface FollowNoticeCopy {
  title: string;
  detail: string;
  tone: FollowNoticeTone;
}

/** Reasons Luna can stop being available (§58, §42.4). */
export type LunaOutageReason =
  | 'timeout'
  | 'error'
  | 'quota'
  | 'budget'
  | 'no_model_access'
  | 'no_key';

const LUNA_COPY: Record<LunaOutageReason, FollowNoticeCopy> = {
  timeout: {
    title: 'Intelligent assist is backing off',
    detail:
      'Luna did not answer in time. CandidCue is following with local matching only and will try again shortly.',
    tone: 'info',
  },
  error: {
    title: 'Intelligent assist is unavailable',
    detail:
      'Luna returned an error. Local matching continues; assist retries on its own backoff schedule.',
    tone: 'info',
  },
  quota: {
    title: 'Intelligent assist is paused — OpenAI quota',
    detail:
      'Your OpenAI project rejected the request for quota or rate reasons. Transcription and local tracking are unaffected.',
    tone: 'info',
  },
  budget: {
    title: 'Intelligent assist reached its session limit',
    detail:
      'CandidCue stopped calling Luna for this session and is following with local matching only.',
    tone: 'info',
  },
  no_model_access: {
    title: 'Intelligent assist is unavailable',
    detail:
      'This OpenAI key cannot reach the assist model. Following continues with local matching only.',
    tone: 'info',
  },
  no_key: {
    title: 'Intelligent assist is off',
    detail: 'No OpenAI key is stored, so CandidCue is following with local matching only.',
    tone: 'info',
  },
};

export function lunaUnavailableCopy(reason: LunaOutageReason): FollowNoticeCopy {
  return LUNA_COPY[reason] ?? LUNA_COPY.error;
}

/**
 * The static half of the degraded-state matrix. `luna_unavailable` is resolved
 * through `lunaUnavailableCopy` because its wording depends on the reason.
 */
export const FOLLOW_NOTICE_COPY: Record<
  Exclude<FollowNoticeId, 'luna_unavailable' | 'budget_exceeded'>,
  FollowNoticeCopy
> = {
  transcription_interrupted: {
    title: 'Reconnecting — position held',
    detail:
      'Transcription dropped out. The stage decelerates and holds your place; it does not keep scrolling on an old pace estimate.',
    tone: 'warning',
  },
  low_transcript_confidence: {
    title: 'Following cautiously',
    detail:
      'The transcript is coming through weakly, so CandidCue is leaning on word order and rare phrases, reducing lead, and holding back tips.',
    tone: 'info',
  },
  frame_performance: {
    title: 'The stage is dropping frames',
    detail:
      'Nonessential visual effects were reduced to keep the text moving smoothly. Motion stays continuous — it never falls back to jumping.',
    tone: 'warning',
  },
  invalid_line_map: {
    title: 'Stage layout needs rebuilding',
    detail:
      'Line measurement came back inconsistent, so motion is held rather than guessing line positions. Rebuild the layout to resume following.',
    tone: 'danger',
  },
};

/** §63 budgets that can be surfaced quietly in control. */
export type RuntimeBudgetId =
  | 'alignment_update'
  | 'stage_frame'
  | 'semantic_latency'
  | 'frame_hitch';

export const RUNTIME_BUDGET_LABELS: Record<RuntimeBudgetId, string> = {
  alignment_update: 'Alignment update',
  stage_frame: 'Stage frame work',
  semantic_latency: 'Assist response time',
  frame_hitch: 'Frame hitches',
};

export function budgetNoticeCopy(
  breaches: Array<{ id: RuntimeBudgetId; observed: number; budget: number; unit: string }>,
): FollowNoticeCopy {
  const names = breaches.map((b) => RUNTIME_BUDGET_LABELS[b.id] ?? b.id);
  const detail = breaches
    .map((b) => `${RUNTIME_BUDGET_LABELS[b.id] ?? b.id}: ${b.observed}${b.unit} against a ${b.budget}${b.unit} budget`)
    .join(' · ');
  return {
    title: names.length === 1 ? `${names[0]} is over budget` : 'Some work is over budget',
    detail: `${detail}. Following continues; this is a measurement, not a failure.`,
    tone: 'info',
  };
}

/* ---------------------------------------------------------------------------
 * "Why did it move?" (§65)
 * ------------------------------------------------------------------------- */

/**
 * The companion §65 fields the control window renders.
 *
 * The engine's record (`src/shared/tracking/decision-log.ts`) carries more
 * triage detail and is the producer; this is deliberately the narrower view it
 * satisfies, so the UI never depends on engine-internal additions and a
 * reduced bridge record can stand in where no engine is running.
 */
export type MovementDecisionRecord = Pick<
  EngineMovementDecisionRecord,
  | 'revision'
  | 'sessionTimeMs'
  | 'fromUnit'
  | 'toUnit'
  | 'behavior'
  | 'stateBefore'
  | 'stateAfter'
  | 'localConfidence'
  | 'secondBestMargin'
  | 'sectionGate'
  | 'semanticAssistRelation'
  | 'semanticAssistInfluence'
  | 'authority'
  | 'visualDisposition'
> & {
  /** Short machine reason from the decision layer, when the producer sets one. */
  reason?: string;
};

const DISPOSITION_PHRASES: Record<MovementDecisionRecord['visualDisposition'], string> = {
  absorbed: 'absorbed into the scroll speed',
  catch_up: 'caught up gradually',
  rewind: 'rewound gently',
  reanchor: 're-anchored in one move',
  hold: 'held in place',
};

const AUTHORITY_PHRASES: Record<MovementDecisionRecord['authority'], string> = {
  ordinary: 'voice following',
  command: 'a voice command',
  manual: 'you',
};

export interface MovementExplanation {
  /** One line: what happened and who authorized it. */
  headline: string;
  /** Supporting sentence naming the evidence class. */
  detail: string;
  /** Compact key/value chips for the diagnostics list. */
  facts: Array<{ label: string; value: string }>;
}

/** Format a §65 record for humans. Redacted by design — no script/transcript text. */
export function describeMovement(record: MovementDecisionRecord): MovementExplanation {
  const distance = record.toUnit - record.fromUnit;
  const direction = distance > 0 ? 'forward' : distance < 0 ? 'back' : 'nowhere';
  const magnitude = Math.abs(distance);
  const moved =
    magnitude === 0
      ? 'Held position'
      : `Moved ${direction} ${magnitude.toFixed(magnitude < 10 ? 1 : 0)} spoken units`;

  const headline = `${moved} — ${FOLLOW_BEHAVIOR_LABELS[record.behavior].toLowerCase()}, ${DISPOSITION_PHRASES[record.visualDisposition]}`;

  const evidence =
    record.semanticAssistRelation !== undefined
      ? `Local match ${formatScore(record.localConfidence)} with a ${formatScore(record.secondBestMargin)} margin over the runner-up; Luna classified it as ${record.semanticAssistRelation}${
          record.semanticAssistInfluence !== undefined
            ? ` (influence ${formatScore(record.semanticAssistInfluence)})`
            : ''
        }.`
      : `Local match ${formatScore(record.localConfidence)} with a ${formatScore(record.secondBestMargin)} margin over the runner-up; no assist input.`;

  const gate =
    record.sectionGate === 'blocked'
      ? ' A section move was blocked — jumps between sections need a command or manual authority.'
      : '';

  const detail = `${FOLLOW_STATE_LABELS[record.stateBefore]} → ${FOLLOW_STATE_LABELS[record.stateAfter]}, authorized by ${AUTHORITY_PHRASES[record.authority]}. ${evidence}${gate}`;

  return {
    headline,
    detail,
    facts: [
      { label: 'Revision', value: String(record.revision) },
      { label: 'Session time', value: formatSessionTime(record.sessionTimeMs) },
      { label: 'Behavior', value: FOLLOW_BEHAVIOR_LABELS[record.behavior] },
      { label: 'State', value: `${record.stateBefore} → ${record.stateAfter}` },
      { label: 'Confidence', value: formatScore(record.localConfidence) },
      { label: 'Margin', value: formatScore(record.secondBestMargin) },
      { label: 'Section gate', value: record.sectionGate },
      { label: 'Authority', value: record.authority },
      { label: 'Motion', value: record.visualDisposition },
      ...(record.semanticAssistRelation !== undefined
        ? [{ label: 'Assist', value: record.semanticAssistRelation }]
        : []),
      ...(record.reason ? [{ label: 'Reason', value: record.reason }] : []),
    ],
  };
}

/** Two decimals, no percentage — scores are model quantities, not certainties. */
export function formatScore(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(2);
}

/** `m:ss.mmm` session-relative stamp for the diagnostics timeline. */
export function formatSessionTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00.000';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor(ms % 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
