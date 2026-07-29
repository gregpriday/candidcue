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
    expect(status).toEqual({ rung: 'none', message: null, tone: 'neutral', hint: null });
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
      'Two matching places — holding here',
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
      expect(status).toEqual({ rung: 'none', message: null, tone: 'neutral', hint: null });
    }
    expect(resolveHoldStatus(held(5000, { hasFault: true, faultLabel: null }))).toEqual({
      rung: 'message',
      message: 'Holding here',
      tone: 'neutral',
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
      // The same key the fault case names, for the same reason: this hold will
      // not clear itself, and one keystroke will carry the script regardless.
      hint: HOLD_FAULT_HINT,
    });
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

  it('carries no icon in any state — least of all a tick on recovery', () => {
    // Recovery is not an achievement. A check mark here would make the ordinary
    // state of the world into an event worth looking away from the script for.
    for (const rung of ['none', 'hollow', 'message'] as const) {
      const body = markup({ rung, message: 'Holding here', tone: 'neutral', secondaryMinPx: 28 });
      expect(body, `${rung} must draw no glyph`).not.toContain('<svg');
    }
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
