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
 * and only a hold long enough to be a real problem earns the top rung. That
 * rung is a MARK for an ordinary hold and a sentence for everything else —
 * see `HoldStatus.glyph`. Each rung
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
 * Beyond this, the top rung.
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
  /**
   * The control window has stopped answering and the stage has frozen itself.
   *
   * Deliberately NOT "frozen": a freeze ordered by a directive is somebody
   * deciding the glass should hold, and announcing that as a failure would
   * report an intention as a fault. This is only the watchdog's reason.
   */
  controlLost?: boolean;
  /** A named hardware condition the presenter can act on. */
  hasFault: boolean;
  /** The name of that condition. Never a code, never "something went wrong". */
  faultLabel: string | null;
  /** §48. Voice following is switched off; the presenter is driving. */
  followPaused?: boolean;
  /**
   * The fixed-pace transport is already carrying the script.
   *
   * Suppresses the recovery hint, because it would be advice to do the thing
   * they are already doing — and a message that describes the state wrongly is
   * worse than no message, particularly the one message on the glass that a
   * presenter has been taught is worth reading.
   */
  autoScrollRunning?: boolean;
}

/**
 * What the presenter can DO about a hold that will not clear itself.
 *
 * Drawn as a key legend — the key as a cap, then two or three words for what it
 * does — because the presenter acquires it in a glance from a camera and the
 * key is the part they act on. A sentence put the key fourth of eight words.
 * `spoken` is the same advice as a sentence, for a screen reader, which would
 * otherwise announce a bare "A, Auto-scroll".
 */
export interface HoldHint {
  keys: readonly string[];
  action: string;
  spoken: string;
}

export interface HoldStatus {
  rung: HoldRung;
  /** The sentence for the `message` rung; null on every other rung. */
  message: string | null;
  tone: HoldTone;
  /**
   * A second line naming what the presenter can DO, or null.
   *
   * Separate from `message` because they are different kinds of sentence and
   * the chip draws them differently: the message names a condition, this names
   * a key. Keeping them apart is also what stops the hint being spoken as part
   * of the condition by a screen reader every time the fault text changes.
   */
  hint: HoldHint | null;
  /**
   * Draw the chip as a mark rather than a sentence.
   *
   * An ordinary hold says one thing — the script is parked where it is — and it
   * is the rung a presenter sees most. Spelled out at the size the optics
   * resolve for secondary text on a 9-inch panel it is a 390px slab across the
   * top-left of the glass, over the script it is reporting on; the words earned
   * none of that room, because the presenter already knows what a paused
   * prompter is.
   *
   * Only ever for that one rung. Everything else here names something a glyph
   * cannot: a fault names a condition to fix, `ambiguous` names a choice the
   * presenter can resolve in about a second, and `Following off` names a switch
   * somebody has to throw back. Those keep their sentences.
   */
  glyph: 'held' | null;
}

/**
 * What to do when the input chain is down.
 *
 * ---------------------------------------------------------------------------
 * WHY A FAULT EARNS A HINT AND A HOLD DOES NOT
 * ---------------------------------------------------------------------------
 * An ordinary hold clears itself: the presenter's next sentence is usually all
 * it needed, and telling somebody mid-sentence to reach for a key would be
 * advice to fix something that is already fixing itself.
 *
 * A fault is the opposite. The microphone is not coming back on its own, so the
 * script will not move again this take no matter what the presenter says — and
 * until now the glass named that condition and stopped there, leaving somebody
 * standing at a camera correctly informed and with nothing to do. The transport
 * is the thing to do, it is one key, and it leaves their hands free afterwards,
 * which stepping the script by arrow keys does not.
 *
 * It names the key rather than describing the feature because the presenter is
 * READING; a key and one word they can act on beats a sentence explaining what
 * auto scrolling is.
 */
export const HOLD_FAULT_HINT: HoldHint = {
  keys: ['A'],
  // The shortcuts sheet's and the toasts' own name for what A does.
  action: 'Auto-scroll',
  spoken: 'Press A to auto-scroll',
};

/**
 * The control window has stopped answering.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SAID AT ALL, WHEN NOTHING ELSE ON THE GLASS CHANGED
 * ---------------------------------------------------------------------------
 * The watchdog freezes the stage and the script stops moving — and that is the
 * whole of what the presenter could previously see. A stopped script is also
 * what an ordinary hold looks like, what a dead microphone looks like, and what
 * a lost alignment looks like: the three-faults-one-symptom ambiguity the rest
 * of this file exists to resolve. Leaving the one failure that is not the
 * presenter's fault, and that their next sentence cannot clear, as the single
 * unlabelled member of that set is how somebody ends up performing a full take
 * to a prompter that stopped listening five seconds in.
 *
 * "Stopped responding" rather than "disconnected": it is true of a control
 * window that crashed AND of one that is merely wedged, and it does not send
 * anybody hunting for a cable or a network that was never involved.
 */
export const CONTROL_LOST_MESSAGE = 'Control stopped responding';

/**
 * The one recovery that still works with control gone.
 *
 * NOT `HOLD_FAULT_HINT`. That names the A key, and A is `auto_scroll_toggle` —
 * an INTENT, sent to control, which is the component that has stopped
 * answering. Printing it here would be advice that cannot work, on the one
 * surface a presenter has been taught is worth reading mid-take, at the one
 * moment they most need it to be true.
 *
 * The arrows are local: they call the script layer's `manualScrollBy` directly,
 * which writes the position synchronously rather than through the frame loop
 * the freeze has stopped. So the script still moves by hand while frozen, and
 * this is the only sentence on the glass that stays honest through a control
 * loss.
 */
export const CONTROL_LOST_HINT: HoldHint = {
  keys: ['↑', '↓'],
  // The shortcuts sheet's "Move the script one line", without the unit.
  action: 'Move the script',
  spoken: 'Use the up and down arrow keys to move the script',
};

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
 * microphone problem that does not exist. It no longer adds "— holding here":
 * the stopped text and the hollow cue have said that already, and the three
 * extra words were what wrapped the chip onto a third row on a 9-inch panel.
 */
export const HOLD_MESSAGES: Record<AlignmentState, string | null> = {
  holding: 'Holding here',
  searching: 'Finding your place',
  ambiguous: 'Two matching places',
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
   * Control loss outranks everything below, including a named fault.
   *
   * Not a judgement about which is worse to live through — it is about which
   * report is still TRUE. Every other input to this function is something
   * control measured and sent: the fault label, the follow switch, the
   * transport's running flag. Once control stops answering, none of them are
   * being refreshed any more, and the most recent values are simply the last
   * thing that was true before the window died. Ranking a stale measurement
   * above the fact that measurement has stopped would put the glass in the
   * position of naming a microphone problem it can no longer observe, while
   * withholding the one condition it can.
   *
   * It is also the only one of them that the presenter cannot clear by
   * speaking, adjusting a setting, or waiting.
   */
  if (input.controlLost === true) {
    return {
      rung: 'message',
      message: CONTROL_LOST_MESSAGE,
      tone: 'fault',
      glyph: null,
      /*
       * Never suppressed by `autoScrollRunning`, unlike the fault hint below.
       * That suppression exists to avoid advising somebody to start a transport
       * that is already carrying the script — but the flag saying it is running
       * came from control, the freeze has stopped the frame loop that ran it,
       * and the script is demonstrably not moving. Withholding the only working
       * recovery on the strength of a stale flag is the worst available trade.
       */
      hint: CONTROL_LOST_HINT,
    };
  }

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
    return {
      rung: 'message',
      message: faultLabel,
      tone: 'fault',
      glyph: null,
      hint: input.autoScrollRunning === true ? null : HOLD_FAULT_HINT,
    };
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
  if (input.followPaused === true && input.autoScrollRunning !== true) {
    /*
     * Unless the transport is already carrying it, in which case the script is
     * MOVING and there is nothing being withheld — the same reason `following`
     * earns no chip below. Switching voice following off and starting the
     * fixed-pace transport is one deliberate act with two halves, and a chip
     * that announced the half that stopped while the other half visibly runs
     * would be the glass disagreeing with itself.
     *
     * The hint is the same key the fault case names, and for the same reason:
     * this hold will not clear itself, and the one thing that will carry the
     * script without a microphone is one keystroke away.
     */
    return {
      rung: 'message',
      message: 'Following off',
      tone: 'neutral',
      glyph: null,
      hint: HOLD_FAULT_HINT,
    };
  }

  const message = HOLD_MESSAGES[input.alignmentState] ?? null;
  if (message === null) {
    // Following. The display is moving; there is nothing being withheld.
    return { rung: 'none', message: null, tone: 'neutral', glyph: null, hint: null };
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
    // The plain hold is the one rung that says nothing a mark cannot.
    glyph: rung === 'message' && input.alignmentState === 'holding' ? 'held' : null,
    // Never on an ordinary hold. See HOLD_FAULT_HINT.
    hint: null,
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
