/**
 * What just happened, in one sentence (CCUX-006, CCUX-007).
 *
 * ---------------------------------------------------------------------------
 * A DECISION SURFACE, NOT A REPORT
 * ---------------------------------------------------------------------------
 * The end-of-take dialog listed nineteen measurements: duration, mode, words
 * heard, words followed, stage updates, pixel travel, transcript bridge counts,
 * followed share, manual jumps, sections, retakes, reconnects, ending location,
 * transcript state. Every one of them earns its place — several were added
 * because a specific failure had been invisible without them — and together
 * they answer a question the presenter did not ask.
 *
 * Somebody walking back from a camera is choosing between about five things:
 * keep going, redo the whole take, redo the last section, fix the microphone,
 * or go back to the script. To choose, they need to know one thing first: did
 * CandidCue hear me, and did it follow? That was derivable from the list and
 * stated nowhere in it.
 *
 * So this module makes the judgement, once, in a pure function, and the
 * measurements move behind a disclosure. Nothing is removed — support and QA
 * still need every row, and the rows are still exact.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL NOT SAY
 * ---------------------------------------------------------------------------
 * Nothing here judges the DELIVERY. CandidCue can say whether it heard and
 * whether it followed; it cannot tell whether a take was good, confident or
 * engaging, and the two analysis lanes that would bear on that are documented
 * as incomplete. An outcome card that called a take "great" would be inventing
 * a measurement, which is the one thing this product does not do.
 */

/** Everything the outcome is allowed to look at. */
export interface TakeOutcomeInput {
  mode: 'voice' | 'manual' | 'fixed';
  /**
   * Whether voice following was even possible this take.
   *
   * False when the take was started past a missing speech model — which
   * readiness deliberately allows, because a take can still roll at a pace and
   * be driven by hand — or its model was found but would not load. Without this
   * the summary told those presenters to go and test their microphone, which
   * was never the problem. Fed from `SessionSummary.voiceFollowingAvailable`.
   */
  voiceFollowingAvailable?: boolean;
  /** Words the recogniser FINALISED. Zero with none in flight means silence. */
  wordsHeard: number;
  /** Words in the utterance still open when the take stopped. */
  wordsInFlight: number;
  /** Share of the take spent following, 0–1, or null when no snapshot arrived. */
  followingShare: number | null;
  /** Times the realtime transport dropped and came back. */
  reconnects: number;
  /** Times the operator moved the script by hand. */
  manualJumps: number;
  durationSeconds: number;
  endingLocation: string;
}

/**
 * A plain-language band for how following went.
 *
 * Product labels, not scores. The precise share is always still available in
 * the details — this exists because "68%" does not tell a presenter whether to
 * run the take again, and "held occasionally" does.
 */
export type FollowHealth =
  | 'steady'
  | 'occasional_holds'
  | 'frequent_help'
  | 'no_tracking'
  | 'no_speech';

export const FOLLOW_HEALTH_LABELS: Record<FollowHealth, string> = {
  steady: 'Followed steadily',
  occasional_holds: 'Held occasionally',
  frequent_help: 'Needed frequent help',
  no_tracking: 'No tracking data',
  no_speech: 'No speech detected',
};

export interface TakeOutcome {
  /** The one sentence that answers "did it work". */
  headline: string;
  /** One supporting line. Always factual, never encouraging. */
  detail: string;
  /** Present only when there is something concrete to do about it. */
  suggestion: string | null;
  health: FollowHealth;
  /**
   * Whether this reads as a problem.
   *
   * Drives tone only. A take that was held a lot is not a failure — long
   * ad-libs and repetitive scripts both produce it legitimately — so the copy
   * explains rather than accuses.
   */
  tone: 'good' | 'neutral' | 'attention';
}

/**
 * A take too short to have measured anything.
 *
 * Below this, "no speech detected" is describing a take that had no chance to
 * contain any, and telling somebody to check their microphone because they
 * ended a take two seconds after starting it would be noise.
 */
const TOO_SHORT_SECONDS = 5;

/** Below this share of the take spent following, the presenter needed help. */
const FREQUENT_HELP_BELOW = 0.4;
/** Above this, following was steady enough not to comment on. */
const STEADY_ABOVE = 0.8;

export function resolveTakeOutcome(input: TakeOutcomeInput): TakeOutcome {
  /*
   * A take with no microphone is not a following result at all. Reporting
   * "nothing was transcribed" for a manual take would be reporting the absence
   * of a subsystem that was never started.
   */
  if (input.mode !== 'voice') {
    return {
      headline: 'Take finished',
      /*
       * Neither branch claims WHAT moved the script beyond what is known. A
       * fixed-mode take does not start rolling on its own — `autoScroll.running`
       * begins false and the transport starts it — so "the script rolled at
       * your set pace" would be false for a fixed take nobody ever started.
       */
      detail: `CandidCue did not follow your voice on this take. You ended in ${input.endingLocation}.`,
      suggestion: null,
      health: 'no_tracking',
      tone: 'neutral',
    };
  }

  /*
   * A voice take that never had a recogniser is not a microphone failure, and
   * must not be reported as one. The presenter was told before they started and
   * chose to go ahead.
   *
   * One answer for all three refusals — not installed, files missing, failed to
   * load. "Install a language" was right for only the first: a model that will
   * not load may be installed already, or be a bundled copy with nothing to
   * install. The take's own toast carried the specific remedy; this points at
   * the screen where every one of them is.
   */
  if (input.voiceFollowingAvailable === false) {
    return {
      headline: 'Take finished without voice following',
      detail: `No usable speech model was available, so CandidCue did not follow your voice. You ended in ${input.endingLocation}.`,
      suggestion: 'Check the speech model in Settings → Speech before the next take.',
      health: 'no_tracking',
      tone: 'neutral',
    };
  }

  const heard = input.wordsHeard + input.wordsInFlight;

  if (heard === 0) {
    // Distinguish "it heard nothing" from "there was nothing to hear yet".
    if (input.durationSeconds < TOO_SHORT_SECONDS) {
      return {
        headline: 'Take ended early',
        detail: 'This take was too short to tell whether CandidCue could hear you.',
        suggestion: null,
        health: 'no_speech',
        tone: 'neutral',
      };
    }
    return {
      headline: 'Nothing was transcribed',
      detail:
        input.manualJumps > 0
          ? `CandidCue did not hear this take, so the ${input.manualJumps === 1 ? 'one move you made was' : `${input.manualJumps} moves you made were`} the only thing that moved the script. Nothing was lost — it is exactly as you left it.`
          : 'The stage stayed where it was, because CandidCue did not hear this take. Nothing was lost — the script is exactly as you left it.',
      suggestion: 'Test or change the microphone in Settings before trying again.',
      health: 'no_speech',
      tone: 'attention',
    };
  }

  /*
   * Heard, but the engine never reported a position. On the single-window path
   * this means the aligner produced no snapshot at all, which is a different
   * fault from holding — and one the presenter cannot do anything about beyond
   * running it again.
   */
  if (input.followingShare === null) {
    return {
      headline: 'CandidCue heard you, but did not track',
      detail: `${heard} words were transcribed and no position was reported, so the stage did not move on its own.`,
      suggestion: 'Present again. If it happens twice, export a support bundle from Settings.',
      health: 'no_tracking',
      tone: 'attention',
    };
  }

  /*
   * Speech recognition that dropped out is named ahead of the following share,
   * because it EXPLAINS a poor share rather than competing with it — and
   * because the remedy is different from anything the presenter could do by
   * reading better. It is not the microphone: a lost input is `micState`, and
   * the recogniser runs on this machine, so there is no cable or link to check.
   */
  if (input.reconnects > 0) {
    return {
      headline: 'Voice following was interrupted',
      detail: `CandidCue held the text through ${input.reconnects === 1 ? 'an interruption' : `${input.reconnects} interruptions`} and picked you up again. You ended in ${input.endingLocation}.`,
      suggestion: 'Present again. If it keeps happening, export a support bundle from Settings.',
      health: healthFromShare(input.followingShare),
      tone: 'attention',
    };
  }

  if (input.followingShare < FREQUENT_HELP_BELOW) {
    return {
      headline: 'Following needed help',
      detail:
        'CandidCue heard you but held its place for much of the take. Long ad-libs, repeated wording, or a weak microphone signal all do this.',
      suggestion: 'Nothing is broken — but if it repeats, the script may need more distinctive openings.',
      health: 'frequent_help',
      tone: 'attention',
    };
  }

  /*
   * The middle band, and its wording is careful for a reason.
   *
   * "Followed most of the take" has to remain TRUE at the bottom of the band,
   * and the technical rows below report "the stage spent most of it holding"
   * under 0.6. Two statements on one dialog that contradict each other cost
   * more trust than either buys, so this band says what it did without
   * quantifying it, and the number is one disclosure away.
   */
  if (input.followingShare < STEADY_ABOVE) {
    return {
      headline: 'CandidCue stayed with you',
      detail: `It followed you and held its place whenever it was unsure. You ended in ${input.endingLocation}.`,
      suggestion: null,
      health: 'occasional_holds',
      tone: 'good',
    };
  }

  return {
    headline: 'CandidCue stayed with you',
    detail:
      input.followingShare >= 1
        ? `Speech was detected and the stage followed for the whole take. You ended in ${input.endingLocation}.`
        : `Speech was detected and the stage followed almost all of the take. You ended in ${input.endingLocation}.`,
    suggestion: null,
    health: 'steady',
    tone: 'good',
  };
}

/** The band for a share that is known to exist. */
function healthFromShare(share: number): FollowHealth {
  if (share < FREQUENT_HELP_BELOW) return 'frequent_help';
  if (share < STEADY_ABOVE) return 'occasional_holds';
  return 'steady';
}
