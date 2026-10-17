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
import type { AlignmentDecision, StageMotionState } from '../../shared/contracts';

/* ---------------------------------------------------------------------------
 * Tracking state (§48 "tracking state in plain language")
 * ------------------------------------------------------------------------- */

/**
 * One short status line per state. Wording reuses the primary F.11 vocabulary
 * ("Holding your place", "Looking for your place", "Voice starting — position
 * held") so Live never speaks two dialects.
 */
export const FOLLOW_STATE_LABELS: Record<StageMotionState, string> = {
  searching: 'Looking for your place',
  following: 'Following',
  holding: 'Holding your place',
  ambiguous: 'Holding your place',
  paused: 'Paused — still listening',
};

/**
 * A one-sentence explanation shown under the status line when it helps.
 *
 * `ambiguous` gets its own wording despite sharing a label with `holding`: the
 * presenter is reading a passage that appears more than once, and "the same
 * words appear twice" is a fact they can act on — by reading a distinctive
 * phrase, or by tapping where they are. "Evidence is thin" would send them
 * looking for a microphone problem that does not exist.
 */
export const FOLLOW_STATE_DETAIL: Record<StageMotionState, string | null> = {
  searching: 'Start speaking and the stage picks up your place.',
  following: null,
  holding: 'The text stays put until the words match the script again.',
  ambiguous: 'These words appear in more than one place, so the text is waiting rather than guessing.',
  paused: 'Automatic movement is stopped. The take is still running.',
};

/** Tone used for the state indicator — calm by default, never alarming. */
export type FollowStateTone = 'neutral' | 'accent' | 'success' | 'warning';

export function followStateTone(state: StageMotionState): FollowStateTone {
  switch (state) {
    case 'following':
      return 'success';
    case 'searching':
      return 'accent';
    // Deliberately NOT 'warning'. Holding is the engine working correctly —
    // refusing to guess — and the research brief is explicit that this moment
    // must read as calm. A warning colour here trains presenters to panic at
    // the exact point the system is being careful on their behalf.
    case 'holding':
    case 'ambiguous':
    default:
      return 'neutral';
  }
}

/* ---------------------------------------------------------------------------
 * Behavior (§52) — why the tracker thinks you moved
 * ------------------------------------------------------------------------- */

/**
 * Diagnostics vocabulary for the engine's decision codes.
 *
 * **These are for the developer diagnostics panel only.** The integration
 * contract is explicit that decision codes must not become user-facing copy —
 * `FOLLOW_STATE_LABELS` is what the presenter reads. The distinction matters
 * because these names describe the engine's internal reasoning, which changes
 * as the engine is tuned; the four states are a promise about behaviour, which
 * does not.
 */
export const FOLLOW_DECISION_LABELS: Record<AlignmentDecision, string> = {
  noEvidence: 'No evidence yet',
  localObserved: 'Local match',
  localConfirmed: 'Local match confirmed',
  holdLowEvidence: 'Holding — weak evidence',
  holdOffScript: 'Holding — off script',
  holdAmbiguous: 'Holding — two places fit',
  holdOffScreen: 'Holding — the match is off screen',
  relocationAccepted: 'Relocated',
  jumpForwardAccepted: 'Jumped forward',
  retakeAccepted: 'Retake accepted',
  jumpPending: 'Possible jump — gathering evidence',
  manualAnchor: 'You moved it',
};

/* ---------------------------------------------------------------------------
 * The one status line (CCUX-001, CCUX-018)
 * ------------------------------------------------------------------------- */

/**
 * Everything the status line is allowed to look at.
 *
 * Narrow on purpose: it is the whole point of this function that the panel
 * cannot reach past it into the decision codes. A component handed the full
 * `SmoothFollowState` will eventually render a field from it, which is exactly
 * how `FOLLOW_DECISION_LABELS` came to be on screen during takes despite the
 * contract above saying it must not be.
 */
export interface FollowStatusInput {
  state: StageMotionState;
  decision: AlignmentDecision;
  /**
   * The operator switched following off — the dock control, the transport
   * checkbox, or the Live panel's button.
   *
   * DELIBERATELY NOT the store's broad `followingPaused`. That flag is ALSO
   * raised automatically when a device is lost or the transcript stops being
   * trustworthy, so reading it as a decision made the app answer a dead
   * microphone with "Text held — CandidCue is still listening": a sentence that
   * is false in both halves, at the moment being wrong costs most. The session
   * store already draws this distinction as `followPausedByUser`, and says why
   * at its declaration.
   */
  heldByUser: boolean;
  /**
   * Fixed-pace scrolling is running.
   *
   * Outranks a hold in the wording, because starting auto-scroll in a voice
   * take deliberately raises the pause flag — following really is off — while
   * the text is visibly moving down the glass. "The text stays where it is" in
   * front of a presenter watching it move is the one kind of wrong that makes
   * somebody stop trusting the whole readout.
   */
  rollingAtPace: boolean;
  /** True once a motion frame has arrived. The UI must not fake liveness. */
  receivingFrames: boolean;
  /** False in a take that opened with no microphone at all. */
  voiceInput: boolean;
  micState: 'live' | 'muted' | 'disconnected';
  /**
   * The INPUT failed — unplugged, silent or refused — as opposed to the
   * realtime transport dying, which also leaves `micState` disconnected.
   *
   * Only this one is fixable by choosing another device, so only this one may
   * say so. Offering a microphone picker as the cure for a recogniser failure
   * is an instruction the user cannot follow, which is the defect §28.6 exists
   * to prevent.
   */
  inputDeviceLost: boolean;
  /**
   * The OS refused the microphone (#303). Neither a device fault nor a
   * recogniser one, so it gets neither of their remedies. Optional so a caller
   * that cannot tell keeps the device/recogniser split it always had.
   */
  microphoneRefused?: boolean;
  /**
   * Whether the recogniser has produced ANY words this take, partial or final.
   *
   * Partials count, and that is not a detail: Rust aligns on partials and
   * publishes snapshots from them, so the script can already be following while
   * the first long utterance is still open. Latching on finals alone put
   * "nothing heard yet — check the microphone" over a take that was visibly
   * working.
   *
   * Equally, not derived from the transcript feed's status: a voice take
   * reports `live` the instant it opens, so that field says a feed was
   * requested and nothing about what came back.
   */
  heardAnything: boolean;
}

export interface FollowStatus {
  line: string;
  detail: string | null;
  tone: FollowStateTone;
}

/**
 * The presenter-facing status, resolved from behaviour rather than reasoning.
 *
 * ---------------------------------------------------------------------------
 * SIGNAL AND MATCHING ARE DIFFERENT FAULTS (CCUX-018)
 * ---------------------------------------------------------------------------
 * "Holding your place" was the answer to two completely different questions,
 * and they have opposite remedies. If CandidCue cannot HEAR you, the fix is the
 * microphone and no amount of re-reading will help. If it can hear you
 * perfectly and the words are not in the script — an ad-lib, an aside, a
 * paragraph skipped on purpose — then nothing is broken at all and the fix is
 * to read the next line on the glass.
 *
 * A presenter told only "holding" will check the microphone first, because that
 * is the failure they can imagine. So the two states say different things.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER, WHICH IS MOST OF THE DESIGN
 * ---------------------------------------------------------------------------
 * These conditions overlap constantly, so the resolver needs an opinion about
 * which to report. Three rules produce the order below:
 *
 *  1. Never describe the text as stationary while it is moving. Auto-scroll
 *     first, always.
 *  2. A fault the operator can act on outranks a state they chose. Somebody who
 *     held the text still needs to know the microphone died before they resume.
 *  3. Nothing may be diagnosed before it is known. The input is checked BEFORE
 *     the "no frames yet" branch, because a dead microphone produces no frames
 *     — so a resolver that answered "Ready to follow" first would sit there
 *     saying "ready" for the whole take, which is precisely the failure
 *     CCUX-018 exists to remove.
 */
export function followStatus(input: FollowStatusInput): FollowStatus {
  const { voiceInput } = input;

  /*
   * 1. An input fault, which outranks everything — including a roll.
   *
   * Rolling used to be checked first, on the reasoning that the text must never
   * be described as stationary while it moves. True, but it made a dead
   * microphone invisible on this panel for as long as the roll was armed, and
   * the fault is the thing the operator has to act on. Both facts fit in one
   * status: the fault is the line, and the roll is named in the detail, so
   * nothing here ever claims the text is still.
   */
  if (voiceInput && input.micState === 'disconnected') {
    const stillMoving = input.rollingAtPace
      ? 'The text is still rolling at your set pace. '
      : 'The text is holding where you left it. ';
    if (input.microphoneRefused) {
      return {
        line: 'Microphone not allowed',
        detail: `${stillMoving}Allow CandidCue in System Settings, then choose Try again.`,
        tone: 'warning',
      };
    }
    return input.inputDeviceLost
      ? {
          line: 'Microphone disconnected',
          detail: `${stillMoving}Choose another input, or carry on and move the text yourself.`,
          tone: 'warning',
        }
      : {
          line: 'Speech recognition stopped',
          detail: `${stillMoving}This is not the microphone — carry on, or end the take and start again.`,
          tone: 'warning',
        };
  }

  // 2. The text is moving. Nothing below may claim otherwise.
  if (input.rollingAtPace) {
    return {
      line: 'Rolling at pace',
      detail: voiceInput
        ? 'The text moves at your set pace. Voice following is off while it rolls.'
        : 'The text moves at your set pace.',
      tone: 'neutral',
    };
  }

  /*
   * 2. Nothing is listening by design — every voice sentence below is a lie.
   *
   * The shared copy is written for voice ("start speaking and the stage picks
   * up your place"), and an operator reads this panel to decide whether a
   * problem is their microphone or their script. On a take with no microphone
   * at all, that copy sends them hunting a fault in a subsystem the take never
   * opened.
   */
  if (!voiceInput) {
    return {
      line: input.state === 'paused' ? 'Paused — the script stays where it is' : 'Manual',
      detail: 'Nothing is listening on this take. The transport moves the script.',
      tone: 'neutral',
    };
  }

  if (input.micState === 'muted') {
    return {
      line: 'Microphone muted',
      detail: 'The text will not move until you unmute. The take is still running.',
      tone: 'neutral',
    };
  }

  // 4. A decision the operator made, now that no fault is hiding behind it.
  if (input.heldByUser) {
    return {
      line: 'Text held',
      detail: 'The text stays where it is. The take is still running and CandidCue is still listening.',
      tone: 'neutral',
    };
  }

  /*
   * 5. Listening, and nothing has come back yet.
   *
   * Hedged rather than accusing, and deliberately not toned as a warning. At
   * the top of a take this is simply true and expected — the presenter has not
   * started — and a red state for "you have not spoken yet" would fire on every
   * single take before its first word.
   */
  if (!input.heardAnything) {
    return {
      line: input.receivingFrames ? 'Listening — nothing heard yet' : 'Ready to follow',
      detail: 'Start speaking and the stage picks up your place. If you have already started, check the microphone.',
      tone: 'accent',
    };
  }

  /*
   * Words are arriving and no position has been reported yet.
   *
   * "Ready to follow — start speaking" belongs to the take that has not begun.
   * Said to somebody who IS speaking — transcript and alignment travel on
   * separate paths, so a partial can land before the first snapshot — it reads
   * as the app not hearing them, which is the opposite of what is happening.
   */
  if (!input.receivingFrames) {
    return {
      line: 'Heard you — finding your place',
      detail: 'CandidCue is matching what you said against the script.',
      tone: 'accent',
    };
  }

  // 7. Heard clearly, matched nothing. Not a fault, and must not read as one.
  if (input.decision === 'holdOffScript') {
    return {
      line: 'Holding your place',
      detail: 'CandidCue can hear you, but these words are not in the script. The text is holding until you come back to it.',
      tone: 'neutral',
    };
  }

  return {
    line: FOLLOW_STATE_LABELS[input.state],
    detail: FOLLOW_STATE_DETAIL[input.state],
    tone: followStateTone(input.state),
  };
}

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
  /** §59 Transcription interrupted. */
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

/**
 * The static half of the degraded-state matrix.
 *
 * There used to be a sixth notice family here, for a second model that ranked
 * the local aligner's candidates — six variants of "assist is unavailable,
 * following continues on local matching". There is no second model now, so
 * following is *always* local matching and there is nothing to report the
 * absence of.
 */
export const FOLLOW_NOTICE_COPY: Record<
  Exclude<FollowNoticeId, 'budget_exceeded'>,
  FollowNoticeCopy
> = {
  // Not "Reconnecting", and not "interrupted" either: this is raised for every
  // state but a ready recogniser — a first start still loading, one that gave
  // up, a pause that closed it — and nothing on this machine reconnects.
  transcription_interrupted: {
    title: 'Voice following unavailable — position held',
    detail:
      'Speech recognition is not ready. The stage decelerates and holds your place; it does not keep scrolling on an old pace estimate.',
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
 * One movement, as the diagnostics timeline records it.
 *
 * Derived from consecutive snapshots rather than reported by the engine: the
 * engine states where the reader is, and "it moved from here to there" is a
 * fact about two of those statements, not a third thing it needs to send.
 * Redacted by design — no script or transcript text ever enters this record.
 */
export interface MovementDecisionRecord {
  /** The snapshot's sequence number. */
  seq: number;
  /** Audio-clock time of the snapshot, ms. */
  audioMs: number;
  fromToken: number;
  toToken: number;
  decision: AlignmentDecision;
  stateBefore: StageMotionState;
  stateAfter: StageMotionState;
  confidence: number;
}

export interface MovementExplanation {
  /** One line: what happened. */
  headline: string;
  /** Supporting sentence naming the evidence class. */
  detail: string;
  /** Compact key/value chips for the diagnostics list. */
  facts: Array<{ label: string; value: string }>;
}

/** Format a movement for humans. */
export function describeMovement(record: MovementDecisionRecord): MovementExplanation {
  const distance = record.toToken - record.fromToken;
  const direction = distance > 0 ? 'forward' : distance < 0 ? 'back' : 'nowhere';
  const magnitude = Math.abs(distance);
  const moved =
    magnitude < 0.05
      ? 'Held position'
      : `Moved ${direction} ${magnitude.toFixed(magnitude < 10 ? 1 : 0)} words`;

  const headline = `${moved} — ${FOLLOW_DECISION_LABELS[record.decision].toLowerCase()}`;
  const transition =
    record.stateBefore === record.stateAfter
      ? FOLLOW_STATE_LABELS[record.stateAfter]
      : `${FOLLOW_STATE_LABELS[record.stateBefore]} → ${FOLLOW_STATE_LABELS[record.stateAfter]}`;
  // "Confidence" is a documented heuristic, not a calibrated probability, so it
  // is reported as a bare score and never as a percentage.
  const detail = `${transition}. Match score ${formatScore(record.confidence)}.`;

  return {
    headline,
    detail,
    facts: [
      { label: 'Seq', value: String(record.seq) },
      { label: 'Audio time', value: formatSessionTime(record.audioMs) },
      { label: 'Decision', value: FOLLOW_DECISION_LABELS[record.decision] },
      { label: 'State', value: `${record.stateBefore} → ${record.stateAfter}` },
      { label: 'From', value: record.fromToken.toFixed(1) },
      { label: 'To', value: record.toToken.toFixed(1) },
      { label: 'Confidence', value: formatScore(record.confidence) },
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
