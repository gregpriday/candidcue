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
 * engaging, because nothing in it analyses delivery. An outcome card that
 * called a take "great" would be inventing a measurement, which is the one
 * thing this product does not do.
 */
import type { FollowingTime } from '../stores/session';
import { formatClock } from './format';

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
  /**
   * The OS was refusing the microphone when the take ended (#303). With
   * nothing heard, that is the reason — not a microphone to test or change.
   */
  microphoneRefused?: boolean;
  /** Words the recogniser FINALISED. Zero with none in flight means silence. */
  wordsHeard: number;
  /** Words in the utterance still open when the take stopped. */
  wordsInFlight: number;
  /**
   * Share of the time following was on that was spent following, 0–1, or null
   * when no snapshot arrived or following was never on.
   */
  followingShare: number | null;
  /**
   * What the share is out of, and the time the presenter took following away
   * for (#287). Absent from a caller that predates it, which then gets exactly
   * the verdicts it always did.
   */
  followingTime?: FollowingTime;
  /**
   * Seconds the recogniser was being sent audio across the whole session, the
   * scope `wordsHeard` is counted over (#287). Absent from an older caller,
   * which is judged on `durationSeconds` as before.
   */
  listenedSeconds?: number;
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
  | 'no_speech'
  | 'not_assessed';

export const FOLLOW_HEALTH_LABELS: Record<FollowHealth, string> = {
  steady: 'Followed steadily',
  occasional_holds: 'Held occasionally',
  frequent_help: 'Needed frequent help',
  no_tracking: 'No tracking data',
  no_speech: 'No speech detected',
  // Not "no tracking data": there may be plenty. Following was not on long
  // enough for any of it to say how following went.
  not_assessed: 'Not assessed',
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
export const TOO_SHORT_SECONDS = 5;

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
  const time = input.followingTime;

  if (heard === 0) {
    /*
     * Refused, so nothing COULD be heard (#303) — before the "too short to
     * tell" answer, because here it is not a question of length. "Test or
     * change the microphone" over this sent the presenter to hardware that was
     * never asked for.
     */
    if (input.microphoneRefused) {
      return {
        headline: 'CandidCue could not use the microphone',
        detail: `This Mac did not allow CandidCue to use the microphone, so it could not follow your voice. You ended in ${input.endingLocation}.`,
        suggestion:
          'Allow CandidCue in System Settings → Privacy & Security → Microphone before the next take.',
        // Not "no speech detected": nothing was listening to detect it.
        health: 'no_tracking',
        tone: 'attention',
      };
    }
    /*
     * Distinguish "it heard nothing" from "there was nothing to hear yet" —
     * and count only the time it was LISTENING (#287). Space and a hard pause
     * both stop the microphone reaching the recogniser, so a take paused for
     * most of its length heard nothing because nothing was sent, and "test the
     * microphone" over it is the same false alarm as over a take ended two
     * seconds in. A roll and following switched off leave listening running,
     * so silence under those is still silence and is still reported.
     *
     * The stand-down answer only when the pass being reported was paused; a
     * short silence with no pause in it is just a short take.
     */
    if ((input.listenedSeconds ?? input.durationSeconds) < TOO_SHORT_SECONDS) {
      if (time && time.pausedSeconds > 0) return standDownOutcome(input, time);
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
        // A roll moves the script by itself, so "the stage stayed where it
        // was" and "your moves were the only thing" are both false under one.
        (time?.autoScrollSeconds ?? 0) > 0
          ? `CandidCue did not hear this take, so nothing but auto-scroll${input.manualJumps > 0 ? ' and your own moves' : ''} moved the script. Nothing was lost — the script itself is unchanged.`
          : input.manualJumps > 0
            ? `CandidCue did not hear this take, so the ${input.manualJumps === 1 ? 'one move you made was' : `${input.manualJumps} moves you made were`} the only thing that moved the script. Nothing was lost — it is exactly as you left it.`
            : 'The stage stayed where it was, because CandidCue did not hear this take. Nothing was lost — the script is exactly as you left it.',
      suggestion: 'Test or change the microphone in Settings before trying again.',
      health: 'no_speech',
      tone: 'attention',
    };
  }

  /*
   * Following was barely asked to run (#287), so there is nothing to judge it
   * on — and that is said before anything that would judge it.
   *
   * A take the presenter paused, switched following off for, or handed to
   * auto-scroll is not one following failed. It used to be scored as if it
   * were: the whole length was the denominator, so a roll from the first line
   * reported "did not track" and a long pause reported "needed help". Ahead of
   * the null share because a roll keeps every snapshot away, and ahead of
   * interruptions because a recogniser that dropped while nobody was asking
   * it to follow cost the presenter nothing on the glass.
   *
   * Only when something WAS set aside. A take that simply ran short is the
   * existing branches' business, and gets exactly the answer it always did.
   */
  if (time && !followingAssessed(time)) return standDownOutcome(input, time);
  const setAside = setAsideSeconds(time);

  /*
   * Heard, but the engine never reported a position. On the single-window path
   * this means the aligner produced no snapshot at all, which is a different
   * fault from holding — and one the presenter cannot do anything about beyond
   * running it again.
   */
  if (input.followingShare === null) {
    return {
      headline: 'CandidCue heard you, but did not track',
      // A roll for part of the take DID move the stage on its own.
      detail:
        setAside > 0
          ? `${heard} words were transcribed and no position was reported while following was on.`
          : `${heard} words were transcribed and no position was reported, so the stage did not move on its own.`,
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

  /*
   * The share is out of the time following was on, so once any time was left
   * out of it "the take" is the wrong noun — 100% of thirty seconds is not the
   * whole of a ninety-second take — and the time left out is named, so the
   * presenter can see why the number is not the one they expected.
   */
  const span = setAside > 0 ? 'the time following was on' : 'the take';
  const left = time ? describeSetAside(time) : null;
  const notCounted = left === null ? '' : ` Not counted: ${left}.`;

  if (input.followingShare < FREQUENT_HELP_BELOW) {
    return {
      headline: 'Following needed help',
      detail: `CandidCue heard you but held its place for much of ${span}. Long ad-libs, repeated wording, or a weak microphone signal all do this.${notCounted}`,
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
      detail: `It followed you and held its place whenever it was unsure.${notCounted} You ended in ${input.endingLocation}.`,
      suggestion: null,
      health: 'occasional_holds',
      tone: 'good',
    };
  }

  return {
    headline: 'CandidCue stayed with you',
    detail:
      input.followingShare < 1
        ? `Speech was detected and the stage followed almost all of ${span}.${notCounted} You ended in ${input.endingLocation}.`
        : setAside > 0
          ? `Speech was detected and the stage followed all of ${span}.${notCounted} You ended in ${input.endingLocation}.`
          : `Speech was detected and the stage followed for the whole take. You ended in ${input.endingLocation}.`,
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

/** Seconds of the pass the presenter took following away for, by any road. */
export function setAsideSeconds(time: FollowingTime | undefined): number {
  return time ? time.pausedSeconds + time.offSeconds + time.autoScrollSeconds : 0;
}

/**
 * Whether the following share has enough time under it to be judged (#287).
 *
 * False only for a take the presenter set following aside on and left it on
 * for under five seconds. The summary's "Followed" row asks the same question
 * the headline does, and answers it from here so the two cannot disagree.
 */
export function followingAssessed(time: FollowingTime | undefined): boolean {
  return !(time && setAsideSeconds(time) > 0 && time.onSeconds < TOO_SHORT_SECONDS);
}

/**
 * The time left out of the share, in words: "1:00 paused and 0:30 on
 * auto-scroll". Null when none of it rounds to a second.
 *
 * Each reason is named separately because they are three different things a
 * presenter did, and one combined figure would leave them to work out which.
 */
export function describeSetAside(time: FollowingTime): string | null {
  const parts: string[] = [];
  const add = (seconds: number, words: string) => {
    const whole = Math.round(seconds);
    if (whole >= 1) parts.push(`${formatClock(whole)} ${words}`);
  };
  add(time.pausedSeconds, 'paused');
  add(time.offSeconds, 'with following off');
  add(time.autoScrollSeconds, 'on auto-scroll');
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
}

/**
 * The answer for a take following was set aside for nearly all of (#287).
 *
 * Named for the biggest of the three reasons, because that is the one the
 * presenter will recognise; the details list every one. Worded as something
 * that HAPPENED in the take, never as how it finished or how much of it: the
 * presenter may have resumed before stopping, and the reason may be the
 * biggest while still the smaller part of a short take. Neutral and with
 * nothing to do, because nothing went wrong — and in particular no support
 * bundle, no microphone and no script advice, each of which is what the old
 * verdicts sent presenters off to chase.
 */
function standDownOutcome(input: TakeOutcomeInput, time: FollowingTime): TakeOutcome {
  const largest = Math.max(time.pausedSeconds, time.offSeconds, time.autoScrollSeconds);
  const headline =
    time.pausedSeconds === largest
      ? 'This take was paused'
      : time.autoScrollSeconds === largest
        ? 'This take used auto-scroll'
        : 'Following was switched off';
  return {
    headline,
    detail: `Voice following was on for under ${TOO_SHORT_SECONDS} seconds, so there is nothing to judge it on. You ended in ${input.endingLocation}.`,
    suggestion: null,
    health: 'not_assessed',
    tone: 'neutral',
  };
}
