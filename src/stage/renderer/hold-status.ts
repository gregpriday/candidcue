/**
 * Progressive hold disclosure: how long the stage waits before it admits, in
 * words, that it has stopped moving.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A LADDER AT ALL
 * ---------------------------------------------------------------------------
 * The engine holds constantly and correctly. It holds through a breath, a
 * swallowed word, a sentence the recogniser lost the tail of — the measured
 * cadence has finals landing 1.2-1.7 s apart, so a hold shorter than that is
 * usually just the gap between one transcript event and the next. Reporting
 * every one of those would put a status message on the glass several times a
 * minute during a take that is going perfectly, and a presenter who learns that
 * the status area lights up for nothing stops reading it at the moment it
 * finally means something.
 *
 * So nothing is said for the first stretch, then something WORDLESS is said,
 * and only a hold long enough to be a real problem gets a sentence. Each rung
 * costs the presenter more attention than the one below it, and each is earned
 * by a hold that has lasted long enough to justify the cost.
 *
 * ---------------------------------------------------------------------------
 * PURE ON PURPOSE
 * ---------------------------------------------------------------------------
 * No DOM, no timers, no clock. The caller owns the stopwatch and hands in an
 * elapsed duration; this decides what that duration means. That is what lets
 * the ladder — including the flap resistance below, which is the part most
 * likely to regress — be tested without a browser.
 */
import type { AlignmentState } from '../../shared/contracts';

/* ---------------------------------------------------------------------------
 * The ladder
 * ------------------------------------------------------------------------- */

/**
 * Below this, say nothing.
 *
 * 1.5 s is a little longer than the interval between transcript finals, so an
 * ordinary gap in recognition — the common case, and not a fault — expires
 * before it reaches the first rung.
 */
export const HOLD_HOLLOW_MS = 1500;

/**
 * Beyond this, use words.
 *
 * By 3.5 s the presenter has noticed the text is not moving, and the question
 * in their head has changed from "is it about to catch up" to "what is it
 * doing". A message that arrives before they have asked is noise; one that
 * arrives after they have asked twice is too late.
 */
export const HOLD_MESSAGE_MS = 3500;

/**
 * How far back below a threshold the timer must fall before the rung it earned
 * is given up.
 *
 * The elapsed time is derived from a clock difference at the top of a 60 Hz
 * frame, and a hold that is genuinely sitting at the threshold will produce
 * values on both sides of it. Without a release band the marker would swap
 * between solid and hollow at frame rate — a flicker on the one element whose
 * entire remit is to stay still. 250 ms is comfortably wider than any jitter a
 * frame clock can produce and far too short for a presenter to perceive as lag.
 */
export const HOLD_HYSTERESIS_MS = 250;

/**
 * What the stage is currently disclosing.
 *
 * - `none`    nothing is drawn beyond the ordinary reading cue;
 * - `hollow`  the reading cue goes from solid to outline. No words, no motion;
 * - `message` a readable chip, positioned away from the text.
 */
export type HoldRung = 'none' | 'hollow' | 'message';

/**
 * `fault` is not an escalation of `neutral` — it is a different claim.
 *
 * A hold is the system working: it declines to guess, and the presenter's own
 * next sentence usually clears it. A fault is the system unable to work, and
 * nothing the presenter says will change that. Rendering them in the same voice
 * would teach presenters to ignore the one that needs them.
 */
export type HoldTone = 'neutral' | 'fault';

export interface HoldStatusInput {
  alignmentState: AlignmentState;
  /** How long the display has been held, milliseconds. */
  holdingForMs: number;
  /** A named hardware condition the presenter can act on. */
  hasFault: boolean;
  /** The name of that condition. Never a code, never "something went wrong". */
  faultLabel: string | null;
  /** §48. Voice following is switched off; the presenter is driving. */
  followPaused?: boolean;
}

export interface HoldStatus {
  rung: HoldRung;
  /** The sentence for the `message` rung; null on every other rung. */
  message: string | null;
  tone: HoldTone;
}

/**
 * The sentence each state earns once it has held long enough to earn one.
 *
 * `following` has none because there is nothing to disclose: the text is
 * moving, and a chip explaining a hold that is not happening is a lie the
 * presenter has no way to check.
 *
 * `ambiguous` is deliberately NOT worded as a failure. "Two matching places" is
 * a fact the presenter can act on in about a second — read a distinctive phrase,
 * or move the text by hand — where "holding" alone would send them looking for a
 * microphone problem that does not exist.
 */
export const HOLD_MESSAGES: Record<AlignmentState, string | null> = {
  holding: 'Holding here',
  searching: 'Finding your place',
  ambiguous: 'Two matching places — holding here',
  following: null,
};

/**
 * Resolve the ladder.
 *
 * Total: every combination of state, duration and fault produces a usable
 * status, including the ones a caller should not be able to produce. A stage
 * component that throws while a take is live takes the script with it.
 *
 * `previous` is the rung this same caller resolved last, and it is what makes
 * the thresholds hysteretic while keeping the function pure — the memory lives
 * in the caller, where it can be reset between takes, rather than in a module
 * that outlives every session in the window.
 */
export function resolveHoldStatus(
  input: HoldStatusInput,
  previous: HoldRung | null = null,
): HoldStatus {
  /*
   * A named fault outranks the ladder and skips it entirely.
   *
   * The ladder's patience is bought by the fact that a hold usually resolves
   * itself. A fault does not: the microphone is not coming back on its own, and
   * every second spent waiting to mention it is a second of a take recorded
   * against a rig that is not listening. So it is said at once.
   */
  const faultLabel = typeof input.faultLabel === 'string' ? input.faultLabel.trim() : '';
  if (input.hasFault && faultLabel.length > 0) {
    return { rung: 'message', message: faultLabel, tone: 'fault' };
  }

  /*
   * A fault flagged with no name falls through to the ladder rather than
   * showing an empty chip. An unnamed alarm is the "something went wrong"
   * language the product voice refuses: it tells the presenter to worry and
   * gives them nothing to do about it, mid-take. The ladder's wording is at
   * least true.
   */

  /*
   * Following is off, and that also skips the ladder — in the other direction.
   *
   * The ladder's patience is bought by a hold resolving itself: say nothing for
   * a second and a half, because the presenter's next sentence probably clears
   * it. Nothing clears this. The script is still because somebody switched the
   * thing that moves it off, and every second spent not saying so is a second
   * of a presenter waiting for a prompter that is never going to advance —
   * which is the single most alarming thing this surface can do, and the one
   * failure the presenter can fix instantly if they are simply told.
   *
   * `neutral`, not `fault`. Nothing is broken; a mode is in force. Wording that
   * treats a deliberate setting as an alarm is how presenters learn to
   * distrust the corner of the glass.
   *
   * BELOW the named fault, deliberately. A microphone that has stopped working
   * is still worth naming while following is off — transcription stays
   * connected either way (§48), so the fault is still true, still actionable,
   * and still the more urgent of the two.
   */
  if (input.followPaused === true) {
    return { rung: 'message', message: 'Following off', tone: 'neutral' };
  }

  const message = HOLD_MESSAGES[input.alignmentState] ?? null;
  if (message === null) {
    // Following. The display is moving; there is nothing being withheld.
    return { rung: 'none', message: null, tone: 'neutral' };
  }

  const elapsed =
    typeof input.holdingForMs === 'number' && Number.isFinite(input.holdingForMs)
      ? Math.max(0, input.holdingForMs)
      : 0;

  const rung = rungFor(elapsed, previous);
  return {
    rung,
    message: rung === 'message' ? message : null,
    tone: 'neutral',
  };
}

/**
 * Which rung an elapsed hold has reached, given the one it was on.
 *
 * Rising thresholds are the published ones; falling thresholds sit a release
 * band lower. A rung is therefore hard to reach and slightly harder to lose,
 * which is the asymmetry that stops a value sitting on a threshold from
 * toggling.
 *
 * The descent is also STEPPED, one rung per call. The elapsed time is not
 * monotonic in practice: a re-anchor inside a hold restarts the caller's
 * stopwatch while the state is still `holding`, so the timer can fall from four
 * seconds to nothing between two frames. Letting that land straight on `none`
 * would take the chip away and refill the reading marker in the same frame —
 * two changes at once on a glass whose entire promise is stillness, and the
 * presenter reads a double change as a glitch rather than as a recovery. A
 * genuine recovery does not go through here at all: `following` returns `none`
 * from the caller above, because the text starting to move is itself the
 * announcement and nothing needs to be eased.
 */
function rungFor(elapsedMs: number, previous: HoldRung | null): HoldRung {
  const heldMessage = previous === 'message';
  const heldHollow = previous === 'hollow' || heldMessage;

  const messageAt = heldMessage ? HOLD_MESSAGE_MS - HOLD_HYSTERESIS_MS : HOLD_MESSAGE_MS;
  const hollowAt = heldHollow ? HOLD_HOLLOW_MS - HOLD_HYSTERESIS_MS : HOLD_HOLLOW_MS;

  if (elapsedMs >= messageAt) return 'message';
  if (elapsedMs >= hollowAt) return 'hollow';
  return heldMessage ? 'hollow' : 'none';
}
