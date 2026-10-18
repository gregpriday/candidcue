/**
 * The hold ladder.
 *
 * Two properties are worth a test here, and they are the two that are cheap to
 * regress by "simplifying" the function:
 *
 *   1. the SILENCE at the bottom of the ladder. A status cue in the first
 *      second and a half of a hold is noise — finals land 1.2-1.7 s apart, so
 *      most holds that short are just the gap between transcript events — and
 *      the fastest way to reintroduce it is to make the thresholds "cleaner";
 *   2. the FLAP RESISTANCE. The elapsed time is a clock difference read at the
 *      top of a frame, so a hold sitting on a threshold produces values either
 *      side of it sixty times a second. Without the release band the reading
 *      marker strobes between solid and hollow, which is the single worst thing
 *      the element whose job is stillness can do.
 *
 * The last block asserts the chip itself, because the interesting half of that
 * component is what it does NOT do — and "it renders nothing" is only a real
 * guarantee if something checks.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import HoldStatus from '../../../src/stage/renderer/HoldStatus.svelte';
import {
  CONTROL_LOST_HINT,
  CONTROL_LOST_MESSAGE,
  HOLD_FAULT_HINT,
  HOLD_HOLLOW_MS,
  HOLD_HYSTERESIS_MS,
  HOLD_MESSAGE_MS,
  resolveHoldStatus,
  type HoldRung,
  type HoldStatusInput,
} from '../../../src/stage/renderer/hold-status';

function held(ms: number, over: Partial<HoldStatusInput> = {}): HoldStatusInput {
  return {
    alignmentState: 'holding',
    holdingForMs: ms,
    hasFault: false,
    faultLabel: null,
    ...over,
  };
}

/** Walk a series of durations the way the stage does, carrying the rung. */
function walk(durations: number[], over: Partial<HoldStatusInput> = {}): HoldRung[] {
  let previous: HoldRung | null = null;
  return durations.map((ms) => {
    const status = resolveHoldStatus(held(ms, over), previous);
    previous = status.rung;
    return status.rung;
  });
}

describe('control loss is said at once, and outranks everything', () => {
  /*
   * The whole point of this block is the PRECEDENCE, not the copy. Control loss
   * and a named hardware fault can be true at the same moment, and both skip
   * the ladder — so which one reaches the glass was previously decided by the
   * order two `if`s happened to be written in. That is exactly the kind of
   * accident that survives a refactor and is only noticed on a live take.
   */
  it('reports immediately, with no ladder delay to serve', () => {
    // Zero elapsed, and an alignment state that is not holding at all: nothing
    // about the ladder should be able to keep this quiet.
    const status = resolveHoldStatus(
      held(0, { alignmentState: 'following', controlLost: true }),
    );
    expect(status.rung).toBe('message');
    expect(status.message).toBe(CONTROL_LOST_MESSAGE);
    expect(status.tone).toBe('fault');
    expect(status.hint).toBe(CONTROL_LOST_HINT);
  });

  it('beats a named hardware fault, because that reading has gone stale', () => {
    const status = resolveHoldStatus(
      held(0, {
        controlLost: true,
        hasFault: true,
        faultLabel: 'No audio',
      }),
    );
    expect(status.message).toBe(CONTROL_LOST_MESSAGE);
    // The microphone reading came from control, and control is what stopped
    // answering — so it is a photograph, not a measurement.
    expect(status.message).not.toBe('No audio');
    expect(status.hint).toBe(CONTROL_LOST_HINT);
  });

  it('beats following-off and a long ordinary hold', () => {
    for (const over of [
      { followPaused: true },
      { alignmentState: 'ambiguous' as const },
      { alignmentState: 'searching' as const },
    ]) {
      const status = resolveHoldStatus(held(HOLD_MESSAGE_MS * 4, { controlLost: true, ...over }));
      expect(status.message, JSON.stringify(over)).toBe(CONTROL_LOST_MESSAGE);
      expect(status.tone).toBe('fault');
    }
  });

  it('never names the A key, which is an intent sent to the window that died', () => {
    const status = resolveHoldStatus(held(0, { controlLost: true }));
    expect(status.hint).not.toBe(HOLD_FAULT_HINT);
    expect(status.hint?.keys).not.toContain('A');
  });

  it('keeps its hint even when the last transport flag said it was running', () => {
    /*
     * `autoScrollRunning` suppresses the FAULT hint, to avoid advising somebody
     * to start a transport already carrying the script. It must not suppress
     * this one: that flag came from control, the freeze has stopped the frame
     * loop that ran the transport, and the script is demonstrably still. This
     * is the only working recovery left, so a stale flag must not withhold it.
     */
    const status = resolveHoldStatus(held(0, { controlLost: true, autoScrollRunning: true }));
    expect(status.hint).toBe(CONTROL_LOST_HINT);
  });

  it('says nothing extra once control is back', () => {
    // The flag going false must return the ordinary ladder, not latch.
    const status = resolveHoldStatus(held(0, { alignmentState: 'following', controlLost: false }));
    expect(status.rung).toBe('none');
    expect(status.message).toBeNull();
  });

  it('leaves a directive-ordered freeze alone', () => {
    /*
     * A freeze somebody ASKED for is not a failure, and this function is only
     * ever handed the watchdog's own reason. Guarded here because the tempting
     * simplification at the call site — passing `app.frozen` — would announce
     * every authored hold as a fault.
     */
    const status = resolveHoldStatus(held(0, { alignmentState: 'following' }));
    expect(status.message).toBeNull();
  });
});

describe('the bottom of the ladder is silence', () => {
  it('says nothing at all for the first 1.5 seconds of a hold', () => {
    for (const ms of [0, 1, 250, 900, 1499]) {
      const status = resolveHoldStatus(held(ms));
      expect(status.rung, `${ms}ms should be silent`).toBe('none');
      expect(status.message).toBeNull();
    }
  });

  it('goes hollow — and only hollow — between 1.5 and 3.5 seconds', () => {
    for (const ms of [HOLD_HOLLOW_MS, 2000, 3499]) {
      const status = resolveHoldStatus(held(ms));
      expect(status.rung, `${ms}ms should be hollow`).toBe('hollow');
      // The whole point of this rung: no words, so nothing to read.
      expect(status.message).toBeNull();
    }
  });

  it('uses words only past 3.5 seconds', () => {
    expect(resolveHoldStatus(held(HOLD_MESSAGE_MS - 1)).rung).toBe('hollow');
    expect(resolveHoldStatus(held(HOLD_MESSAGE_MS)).rung).toBe('message');
    expect(resolveHoldStatus(held(9000)).rung).toBe('message');
  });

  it('never moves the display while following, however long the timer reads', () => {
    // A caller that forgets to reset its stopwatch must not produce a chip
    // claiming a hold that is not happening — the presenter can see the text
    // moving and would rightly stop trusting everything else on the glass.
    const status = resolveHoldStatus(held(30_000, { alignmentState: 'following' }));
    expect(status).toEqual({ rung: 'none', message: null, tone: 'neutral', glyph: null, hint: null });
  });
});

describe('what the message rung says', () => {
  it('names the state rather than describing the machine', () => {
    expect(resolveHoldStatus(held(4000, { alignmentState: 'holding' })).message).toBe(
      'Holding here',
    );
    expect(resolveHoldStatus(held(4000, { alignmentState: 'searching' })).message).toBe(
      'Finding your place',
    );
    expect(resolveHoldStatus(held(4000, { alignmentState: 'ambiguous' })).message).toBe(
      'Two matching places',
    );
  });

  it('keeps a hold neutral in tone — holding is the engine working', () => {
    for (const state of ['holding', 'searching', 'ambiguous'] as const) {
      expect(resolveHoldStatus(held(8000, { alignmentState: state })).tone).toBe('neutral');
    }
  });
});

describe('a named fault outranks the ladder', () => {
  it('shows immediately, without serving the 1.5 second wait', () => {
    const status = resolveHoldStatus(
      held(0, { hasFault: true, faultLabel: 'No audio from the microphone' }),
    );
    expect(status).toEqual({
      rung: 'message',
      message: 'No audio from the microphone',
      tone: 'fault',
      // A fault names a condition to fix; a mark cannot.
      glyph: null,
      hint: HOLD_FAULT_HINT,
    });
  });

  it('outranks a long hold that had earned its own message', () => {
    const status = resolveHoldStatus(
      held(20_000, { alignmentState: 'searching', hasFault: true, faultLabel: 'Microphone in use' }),
    );
    expect(status.message).toBe('Microphone in use');
    expect(status.tone).toBe('fault');
  });

  it('falls back to the ladder when the fault has no name', () => {
    // A nameless alarm is exactly the "something went wrong" the product voice
    // refuses: it tells the presenter to worry, mid-take, and gives them
    // nothing to act on. The ladder's wording is at least true.
    for (const label of [null, '', '   ']) {
      const status = resolveHoldStatus(held(400, { hasFault: true, faultLabel: label }));
      expect(status).toEqual({ rung: 'none', message: null, tone: 'neutral', glyph: null, hint: null });
    }
    expect(resolveHoldStatus(held(5000, { hasFault: true, faultLabel: null }))).toEqual({
      rung: 'message',
      message: 'Holding here',
      tone: 'neutral',
      glyph: 'held',
      hint: null,
    });
  });

  it('names the recovery, because a fault is the one hold that will not clear itself', () => {
    /*
     * The presenter is at a camera with a script that has stopped and no reason
     * to believe anything they do will restart it. Naming the condition and
     * stopping there leaves them correctly informed and stuck.
     */
    const status = resolveHoldStatus(held(0, { hasFault: true, faultLabel: 'No audio' }));
    expect(status.hint).toBe(HOLD_FAULT_HINT);
  });

  it('withdraws the hint once the transport is already carrying the script', () => {
    // Advice to do the thing they are visibly already doing reads as the chip
    // not knowing what is going on — on the one message worth reading.
    const status = resolveHoldStatus(
      held(0, { hasFault: true, faultLabel: 'No audio', autoScrollRunning: true }),
    );
    expect(status.message).toBe('No audio');
    expect(status.tone).toBe('fault');
    expect(status.hint).toBeNull();
  });

  it('never hints on an ordinary hold, which usually clears itself', () => {
    for (const state of ['holding', 'searching', 'ambiguous'] as const) {
      expect(resolveHoldStatus(held(20_000, { alignmentState: state })).hint).toBeNull();
    }
  });
});

describe('following switched off skips the ladder too (§48)', () => {
  it('says so at once, because nothing is going to clear it', () => {
    /*
     * The ladder's patience is bought by a hold resolving itself — say nothing
     * for a second and a half, because the presenter's next sentence probably
     * fixes it. Nothing fixes this one. Waiting would leave somebody staring at
     * a script that is never going to advance, with no explanation.
     */
    const status = resolveHoldStatus(held(0, { alignmentState: 'following', followPaused: true }));
    expect(status).toEqual({
      rung: 'message',
      message: 'Following off',
      tone: 'neutral',
      // A switch somebody has to throw back is not an ordinary hold.
      glyph: null,
      // The same key the fault case names, for the same reason: this hold will
      // not clear itself, and one keystroke will carry the script regardless.
      hint: HOLD_FAULT_HINT,
    });
  });

  it('marks a plain hold rather than spelling it out, and only a plain hold', () => {
    /*
     * The chip is drawn at the floor the optics resolve for secondary text, so
     * on a 9-inch Prompter "Holding here" is a ~390px slab across the top-left
     * of the glass, sitting over the script it is reporting on. The presenter
     * already knows what a paused prompter is; the words earned none of that
     * room.
     *
     * Everything else keeps its sentence, and that is the half worth pinning:
     * `ambiguous` names a choice the presenter can act on in about a second,
     * and a mark cannot say it.
     */
    expect(resolveHoldStatus(held(5000)).glyph).toBe('held');
    expect(resolveHoldStatus(held(5000, { alignmentState: 'searching' })).glyph).toBeNull();
    expect(resolveHoldStatus(held(5000, { alignmentState: 'ambiguous' })).glyph).toBeNull();
  });

  it('marks nothing on the rungs that say nothing', () => {
    // The mark belongs to the sentence, so it may not outlive it: a rung with
    // no message must not draw a chip with a glyph alone in it.
    expect(resolveHoldStatus(held(0)).glyph).toBeNull();
    expect(resolveHoldStatus(held(0, { alignmentState: 'following' })).glyph).toBeNull();
  });

  it('is neutral, not a fault: a mode in force is not a thing gone wrong', () => {
    expect(resolveHoldStatus(held(9000, { followPaused: true })).tone).toBe('neutral');
  });

  it('still lets a named fault through, because that one is still true', () => {
    // Transcription stays connected while following is off (§48), so a
    // microphone that has stopped working is both real and more urgent.
    const status = resolveHoldStatus(
      held(0, { followPaused: true, hasFault: true, faultLabel: 'No audio' }),
    );
    expect(status).toEqual({
      rung: 'message',
      message: 'No audio',
      tone: 'fault',
      glyph: null,
      hint: HOLD_FAULT_HINT,
    });
  });

  it('says nothing while the transport is carrying the script', () => {
    /*
     * Switching voice following off and starting the fixed-pace transport is
     * one deliberate act with two halves. Announcing the half that stopped
     * while the other half is visibly running would be the glass disagreeing
     * with itself — and the script IS moving, which is the same reason
     * `following` earns no chip at all.
     */
    const status = resolveHoldStatus(
      held(0, { alignmentState: 'following', followPaused: true, autoScrollRunning: true }),
    );
    expect(status.rung).toBe('none');
    expect(status.message).toBeNull();
  });

  it('goes quiet again the moment following comes back', () => {
    const status = resolveHoldStatus(
      held(0, { alignmentState: 'following', followPaused: false }),
      'message',
    );
    expect(status.rung).toBe('none');
    expect(status.message).toBeNull();
  });
});

describe('the rung does not flap', () => {
  it('holds hollow while the timer oscillates across the 1.5 s threshold', () => {
    // What a frame clock actually produces: the same hold, sampled either side
    // of the threshold on consecutive frames.
    const jitter = [1490, 1510, 1495, 1505, 1480, 1520, 1470, 1499];
    const rungs = walk(jitter);

    // It may take a sample or two to climb — but once it is hollow it stays
    // hollow for the rest of the oscillation.
    const firstHollow = rungs.indexOf('hollow');
    expect(firstHollow).toBeGreaterThanOrEqual(0);
    expect(rungs.slice(firstHollow).every((rung) => rung === 'hollow')).toBe(true);
  });

  it('holds the message while the timer oscillates across the 3.5 s threshold', () => {
    const jitter = [3490, 3510, 3480, 3505, 3460, 3499, 3520];
    const rungs = walk(jitter);

    const firstMessage = rungs.indexOf('message');
    expect(firstMessage).toBeGreaterThanOrEqual(0);
    expect(rungs.slice(firstMessage).every((rung) => rung === 'message')).toBe(true);
  });

  it('gives a rung up only once the timer falls a clear band below it', () => {
    // Inside the release band: still held.
    expect(resolveHoldStatus(held(HOLD_MESSAGE_MS - HOLD_HYSTERESIS_MS), 'message').rung).toBe(
      'message',
    );
    expect(resolveHoldStatus(held(HOLD_HOLLOW_MS - HOLD_HYSTERESIS_MS), 'hollow').rung).toBe(
      'hollow',
    );

    // Past it: released.
    expect(resolveHoldStatus(held(HOLD_MESSAGE_MS - HOLD_HYSTERESIS_MS - 1), 'message').rung).toBe(
      'hollow',
    );
    expect(resolveHoldStatus(held(HOLD_HOLLOW_MS - HOLD_HYSTERESIS_MS - 1), 'hollow').rung).toBe(
      'none',
    );
  });

  it('cannot drop two rungs in one step, however far the stopwatch falls', () => {
    // The case that matters is not a timer drifting one millisecond below the
    // release band — it is a re-anchor INSIDE a hold, which restarts the
    // caller's stopwatch while the state is still `holding`. The timer then
    // falls from four seconds to nothing between two frames, and a naive
    // threshold would take the chip away and refill the reading marker in the
    // same frame. Two changes at once reads as a glitch, not as a recovery.
    for (const ms of [0, 1, 200, 900, HOLD_HOLLOW_MS - HOLD_HYSTERESIS_MS - 1]) {
      expect(resolveHoldStatus(held(ms), 'message').rung, `${ms}ms from the chip`).toBe('hollow');
    }
    // And the step after that is the one that reaches silence.
    expect(resolveHoldStatus(held(0), 'hollow').rung).toBe('none');
  });

  it('still clears everything at once when the text starts moving again', () => {
    // The stepped descent is for a hold that is still a hold. A real recovery
    // is announced by the script moving, so easing the chip out over two frames
    // there would only delay the glass agreeing with itself.
    expect(resolveHoldStatus(held(9000, { alignmentState: 'following' }), 'message').rung).toBe(
      'none',
    );
  });

  it('climbs from silence at the published thresholds, not the released ones', () => {
    // Hysteresis must be one-directional: a hold that has never been reported
    // still waits the full 1.5 s, or the release band would quietly become the
    // real threshold.
    expect(resolveHoldStatus(held(HOLD_HOLLOW_MS - 1), null).rung).toBe('none');
    expect(resolveHoldStatus(held(HOLD_HOLLOW_MS - 1), 'none').rung).toBe('none');
    expect(resolveHoldStatus(held(HOLD_MESSAGE_MS - 1), 'hollow').rung).toBe('hollow');
  });
});

describe('total for inputs that should not exist', () => {
  it('treats a broken stopwatch as no hold at all', () => {
    // NaN and Infinity mean the clock is wrong, not that the hold is long. A
    // permanent chip pinned to the glass by a bad subtraction is worse than
    // saying nothing: the presenter cannot dismiss it and cannot act on it.
    for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, -1, -50_000]) {
      expect(resolveHoldStatus(held(ms)).rung).toBe('none');
    }
  });

  it('says nothing for a state it does not recognise', () => {
    const status = resolveHoldStatus(
      held(10_000, {
        alignmentState: 'transcribing' as unknown as HoldStatusInput['alignmentState'],
      }),
    );
    expect(status.rung).toBe('none');
  });
});

describe('the chip', () => {
  function markup(props: {
    rung: HoldRung;
    message: string | null;
    tone: 'neutral' | 'fault';
    secondaryMinPx: number;
    glyph?: 'held' | null;
  }): string {
    return render(HoldStatus, { props }).body;
  }

  it('shows itself and its words only on the message rung', () => {
    const shown = markup({
      rung: 'message',
      message: 'Holding here',
      tone: 'neutral',
      secondaryMinPx: 28,
    });
    expect(shown).toContain('data-visible="true"');
    expect(shown).toContain('Holding here');

    for (const rung of ['none', 'hollow'] as const) {
      const hidden = markup({ rung, message: null, tone: 'neutral', secondaryMinPx: 28 });
      expect(hidden, `${rung} must draw nothing`).toContain('data-visible="false"');
    }
  });

  /*
   * The element stays in the tree on every rung rather than being added and
   * removed. A chip that was unmounted and remounted would pop into existence
   * at full opacity beside a script somebody is reading — the same defect the
   * voice pill's permanent mount exists to avoid — and there would be nothing
   * left to run the recovery fade on.
   */
  it('stays mounted on every rung so recovery can fade rather than vanish', () => {
    const gone = markup({ rung: 'none', message: null, tone: 'neutral', secondaryMinPx: 28 });
    expect(gone).toContain('class="hold-status');
  });

  it('carries no icon unless the resolver asked for one — least of all a tick on recovery', () => {
    // Recovery is not an achievement. A check mark here would make the ordinary
    // state of the world into an event worth looking away from the script for.
    for (const rung of ['none', 'hollow', 'message'] as const) {
      const body = markup({ rung, message: 'Holding here', tone: 'neutral', secondaryMinPx: 28 });
      expect(body, `${rung} must draw no glyph`).not.toContain('<svg');
    }
  });

  it('draws the mark instead of the words, and keeps the words for the ear', () => {
    const body = markup({
      rung: 'message',
      message: 'Holding here',
      tone: 'neutral',
      secondaryMinPx: 28,
      glyph: 'held',
    });
    expect(body).toContain('<svg');
    // The sentence is still in the live region, and still hidden from the glass.
    expect(body).toContain('sr-only');
    expect(body).toContain('Holding here');
    /*
     * Not the transport's pause bars. This app draws two upright bars for its
     * own Pause command on Space, and the same shape here would tell a
     * presenter that capture had stopped — the one response that cannot clear
     * an alignment hold. The mark is the reading cue's own triangles.
     */
    expect(body).not.toContain('<rect');
  });

  it('sizes itself at the secondary-text floor rather than a fixed small value', () => {
    expect(
      markup({ rung: 'message', message: 'Holding here', tone: 'neutral', secondaryMinPx: 43 }),
    ).toContain('font-size: 43px');
    // A missing or nonsense floor must still land somewhere readable, never 0.
    expect(
      markup({ rung: 'message', message: 'Holding here', tone: 'neutral', secondaryMinPx: 0 }),
    ).toContain('font-size: 18px');
  });

  it('marks a fault as a different kind of claim, not a louder hold', () => {
    const fault = markup({
      rung: 'message',
      message: 'No audio from the microphone',
      tone: 'fault',
      secondaryMinPx: 28,
    });
    expect(fault).toContain('data-tone="fault"');
    expect(fault).toContain('No audio from the microphone');
  });
});
