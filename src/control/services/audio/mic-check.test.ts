/**
 * The microphone check decides one thing — may this take start — and it is the
 * only gate standing between a presenter and a silent take. Two failure modes
 * matter more than everything else here and each has its own tests:
 *
 *   • passing on a microphone that is NOT working. A check that waves through
 *     a dead or unusably quiet input is worse than no check at all: it adds a
 *     step and then certifies the exact fault it was added to catch.
 *   • failing a microphone that IS working. A presenter who cannot get past
 *     the gate on a good rig will stop using the product, and rightly.
 */
import { describe, expect, it } from 'vitest';
import type { AudioLevelSnapshot } from '../../../shared/contracts';
import {
  INITIAL_MIC_CHECK_STATE,
  MIC_CHECK_OVERRIDE_AFTER_MS,
  MIC_CHECK_SPEECH_MS,
  MIC_CHECK_TRACE_SAMPLES,
  micCheckCanOverride,
  micCheckView,
  reduceMicCheck,
  type MicCheckState,
} from './mic-check';
import { NO_SIGNAL_AFTER_MS, TOO_LOW_PEAK } from '../../components/mic-advice';

/** A frame at the ~90 ms analysis cadence. */
const FRAME_MS = 90;

function frame(overrides: Partial<AudioLevelSnapshot> & { generatedAtMs: number }): AudioLevelSnapshot {
  return {
    rms: 0.2,
    peak: 0.4,
    noiseFloor: 0.02,
    speaking: false,
    clipped: false,
    signalPresent: true,
    ...overrides,
  };
}

/** Feed `count` frames from `startMs`, `FRAME_MS` apart. */
function feed(
  state: MicCheckState,
  count: number,
  startMs: number,
  make: (atMs: number) => Partial<AudioLevelSnapshot>,
): MicCheckState {
  let next = state;
  for (let i = 0; i < count; i += 1) {
    const atMs = startMs + i * FRAME_MS;
    next = reduceMicCheck(next, frame({ ...make(atMs), generatedAtMs: atMs }), atMs);
  }
  return next;
}

const speaking = () => ({ rms: 0.28, peak: 0.45, speaking: true, signalPresent: true });
const silent = () => ({ rms: 0, peak: 0, speaking: false, signalPresent: false });

describe('reduceMicCheck — passing', () => {
  it('passes once enough voice has arrived at a usable level', () => {
    // Comfortably past the threshold: 20 frames ≈ 1.8 s of speech.
    const state = feed(INITIAL_MIC_CHECK_STATE, 20, 1000, speaking);
    expect(state.usableSpeechMs).toBeGreaterThanOrEqual(MIC_CHECK_SPEECH_MS);
    expect(state.passed).toBe(true);
  });

  it('does not pass on a single loud frame', () => {
    const state = feed(INITIAL_MIC_CHECK_STATE, 1, 1000, speaking);
    expect(state.passed).toBe(false);
  });

  it('stays passed after the presenter falls silent', () => {
    // Going quiet the moment you have proved the microphone works is the
    // normal thing to do, not evidence that it does not.
    const heard = feed(INITIAL_MIC_CHECK_STATE, 20, 1000, speaking);
    const after = feed(heard, 40, 3000, silent);
    expect(after.passed).toBe(true);
  });

  it('says "too quiet" rather than "hearing you" once that is the only thing blocking it', () => {
    /*
     * `micCondition` ranks `speaking` above `too_low`, which is correct for the
     * Preflight meter and wrong here: a presenter whose input cannot pass would
     * be told "Hearing you" indefinitely while nothing happened — the exact
     * failure this screen exists to abolish, reproduced inside it.
     */
    const quiet = () => ({
      rms: TOO_LOW_PEAK / 3,
      peak: TOO_LOW_PEAK / 2,
      speaking: true,
      signalPresent: true,
    });
    // Before the speech threshold, nothing is wrong yet.
    const early = feed(INITIAL_MIC_CHECK_STATE, 2, 1000, quiet);
    const earlyAtMs = 1000 + FRAME_MS;
    expect(
      micCheckView(early, frame({ ...quiet(), generatedAtMs: earlyAtMs }), earlyAtMs, 1000).state,
    ).toBe('hearing');

    // Past it, the only remaining obstacle is level — so say so.
    const later = feed(INITIAL_MIC_CHECK_STATE, 30, 1000, quiet);
    const laterAtMs = 1000 + 29 * FRAME_MS;
    expect(
      micCheckView(later, frame({ ...quiet(), generatedAtMs: laterAtMs }), laterAtMs, 1000).state,
    ).toBe('too_low');
  });

  it('never passes a signal too quiet to transcribe, however long it runs', () => {
    /*
     * The VAD makes a speech/silence decision, not a loudness one, so a very
     * quiet voice can trip `speaking` indefinitely. Passing on that would wave
     * through the case that produces a transcript full of holes — which is
     * harder to diagnose than silence, not easier.
     */
    const quiet = () => ({
      rms: TOO_LOW_PEAK / 3,
      peak: TOO_LOW_PEAK / 2,
      speaking: true,
      signalPresent: true,
    });
    const state = feed(INITIAL_MIC_CHECK_STATE, 60, 1000, quiet);
    const lastAtMs = 1000 + 59 * FRAME_MS;
    // Plenty of speech, none of it usable — the two are counted separately so
    // that quiet audio can never be mistaken for evidence the take will work.
    expect(state.quietSpeechMs).toBeGreaterThan(MIC_CHECK_SPEECH_MS * 3);
    expect(state.usableSpeechMs).toBe(0);
    expect(state.passed).toBe(false);
    expect(
      micCheckView(state, frame({ ...quiet(), generatedAtMs: lastAtMs }), lastAtMs, 1000).state,
    ).toBe('too_low');
  });

  it('does not credit a stalled stream as speech', () => {
    /*
     * Frames seconds apart are not seconds of speech.
     *
     * This is the sharpest version of the bug: the credit used to be CAPPED at
     * MAX_FRAME_CREDIT_MS rather than refused, so six surviving frames of a
     * dead stream each claimed the full 280 ms and bought 1.4 s — passing the
     * check on the evidence that the capture had stopped working.
     */
    let state = INITIAL_MIC_CHECK_STATE;
    for (let i = 0; i < 8; i += 1) {
      const atMs = 1000 + i * 5000;
      state = reduceMicCheck(state, frame({ ...speaking(), generatedAtMs: atMs }), atMs);
    }
    expect(state.usableSpeechMs).toBe(0);
    expect(state.passed).toBe(false);
  });

  it('passes a real voice whose level dips between syllables', () => {
    /*
     * The false-BLOCK case, and the reason the level gate is a speech-scoped
     * hold rather than a per-frame test.
     *
     * Measured speech in this codebase runs at an RMS of 0.03–0.12 (see
     * `calibrationPercentile` in audio/defaults.ts), so a perfectly good
     * microphone produces frames whose instantaneous peak falls under the
     * usable-level line between syllables. Gating frame by frame credited such
     * a speaker only sporadically — a working rig that could not get through
     * the gate is a worse failure than no gate at all.
     */
    const modulating = (atMs: number) => {
      const loud = Math.floor(atMs / FRAME_MS) % 3 !== 0;
      return {
        rms: loud ? 0.2 : 0.04,
        peak: loud ? 0.34 : TOO_LOW_PEAK / 2,
        speaking: true,
        signalPresent: true,
      };
    };
    const state = feed(INITIAL_MIC_CHECK_STATE, 20, 1000, modulating);
    expect(state.passed).toBe(true);
  });

  it('never passes sustained clipping', () => {
    /*
     * Clipping is loud, so it sails through any loudness gate, and it trips the
     * VAD like any other speech — but clipped audio transcribes badly, which is
     * exactly the outcome this check exists to prevent. Passing it would be the
     * check certifying the fault.
     */
    const clipping = () => ({
      rms: 0.95,
      peak: 1,
      speaking: true,
      clipped: true,
      signalPresent: true,
    });
    const state = feed(INITIAL_MIC_CHECK_STATE, 60, 1000, clipping);
    const lastAtMs = 1000 + 59 * FRAME_MS;
    expect(state.usableSpeechMs).toBe(0);
    expect(state.passed).toBe(false);
    expect(
      micCheckView(state, frame({ ...clipping(), generatedAtMs: lastAtMs }), lastAtMs, 1000).state,
    ).toBe('clipping');
  });

  it('passes once clipping is corrected', () => {
    // The remedy has to work: a presenter who turns their gain down must be
    // able to get through, not be latched out by the earlier reading.
    const clipping = () => ({
      rms: 0.95,
      peak: 1,
      speaking: true,
      clipped: true,
      signalPresent: true,
    });
    const clipped = feed(INITIAL_MIC_CHECK_STATE, 20, 1000, clipping);
    expect(clipped.passed).toBe(false);
    const recovered = feed(clipped, 25, 1000 + 20 * FRAME_MS, speaking);
    expect(recovered.passed).toBe(true);
  });

  it('does not let a loud noise supply the loudness for quiet speech', () => {
    /*
     * The peak hold remembers the loudest thing in a three-second window,
     * including a door slam. When speech time and loudness were accumulated as
     * independent facts, an unrelated transient satisfied the level gate while
     * quiet speech satisfied the duration one — and the check passed a
     * microphone nobody had spoken usefully into.
     */
    const knock = () => ({ rms: 0.9, peak: 0.95, speaking: false, signalPresent: true });
    const quiet = () => ({
      rms: TOO_LOW_PEAK / 3,
      peak: TOO_LOW_PEAK / 2,
      speaking: true,
      signalPresent: true,
    });
    const banged = feed(INITIAL_MIC_CHECK_STATE, 2, 1000, knock);
    const then = feed(banged, 25, 1000 + 2 * FRAME_MS, quiet);
    expect(then.passed).toBe(false);
  });

  it('passes exactly at the threshold and not one frame before', () => {
    // Both sides of the boundary, so the threshold cannot drift unnoticed.
    let state = INITIAL_MIC_CHECK_STATE;
    let atMs = 1000;
    // The first frame establishes the clock and earns no credit.
    state = reduceMicCheck(state, frame({ ...speaking(), generatedAtMs: atMs }), atMs);
    while (state.usableSpeechMs + FRAME_MS < MIC_CHECK_SPEECH_MS) {
      atMs += FRAME_MS;
      state = reduceMicCheck(state, frame({ ...speaking(), generatedAtMs: atMs }), atMs);
    }
    expect(state.passed).toBe(false);
    atMs += FRAME_MS;
    state = reduceMicCheck(state, frame({ ...speaking(), generatedAtMs: atMs }), atMs);
    expect(state.usableSpeechMs).toBeGreaterThanOrEqual(MIC_CHECK_SPEECH_MS);
    expect(state.passed).toBe(true);
  });
});

describe('malformed frames', () => {
  it('ignores a frame carrying NaN rather than poisoning the state', () => {
    /*
     * NaN compares false against every threshold, so it does not TRIP the
     * guards — it silently disables them, and flows on into the peak hold, the
     * waveform (`height: NaN%`) and the timestamps.
     */
    const healthy = feed(INITIAL_MIC_CHECK_STATE, 5, 1000, speaking);
    const poisoned = reduceMicCheck(
      healthy,
      frame({ rms: NaN, peak: NaN, speaking: true, generatedAtMs: 1000 + 5 * FRAME_MS }),
      1000 + 5 * FRAME_MS,
    );
    expect(poisoned).toEqual(healthy);
    for (const level of poisoned.levels) expect(Number.isFinite(level)).toBe(true);
  });

  it('ignores a frame whose timestamp goes backwards', () => {
    /*
     * An out-of-order frame would rewrite `lastFrameAtMs` into the past, which
     * both hands the NEXT frame an inflated gap and makes a live stream look
     * stale to the view.
     */
    const state = feed(INITIAL_MIC_CHECK_STATE, 5, 1000, speaking);
    const rewound = reduceMicCheck(state, frame({ ...speaking(), generatedAtMs: 500 }), 500);
    expect(rewound).toEqual(state);
    expect(rewound.lastFrameAtMs).toBe(state.lastFrameAtMs);
  });
});

describe('micCheckView — what the presenter is told', () => {
  it('asks for a voice before anything has been measured', () => {
    const view = micCheckView(INITIAL_MIC_CHECK_STATE, null, 1000, 1000);
    expect(view.state).toBe('waiting');
    expect(view.headline).toMatch(/say something/i);
  });

  it('reports a sustained absence of signal as an unusable microphone', () => {
    const state = feed(INITIAL_MIC_CHECK_STATE, 40, 1000, silent);
    const nowMs = 1000 + 40 * FRAME_MS;
    const view = micCheckView(state, frame({ ...silent(), generatedAtMs: nowMs }), nowMs, 1000);
    expect(view.state).toBe('unheard');
    expect(view.detail).toMatch(/muted|input|using it/i);
  });

  it('reports "unheard" when no frame ever arrives at all', () => {
    /*
     * The permission-refused / device-pulled / another-app-has-it case. There
     * is no level frame to reason from, so `micCondition` can only say `idle` —
     * indistinguishable from the first 90 ms of a healthy capture. Left there,
     * the presenter reads "say something" at a microphone that will never be
     * heard, forever.
     */
    const view = micCheckView(
      INITIAL_MIC_CHECK_STATE,
      null,
      1000 + NO_SIGNAL_AFTER_MS,
      1000,
    );
    expect(view.state).toBe('unheard');
  });

  it('reports "unheard" when the capture dies mid-check', () => {
    /*
     * A stream that stops delivering freezes `level` at whatever it last said.
     * If that final frame carried `signalPresent: true` — the normal case for a
     * device yanked mid-sentence — every later reading is computed from it, and
     * the check would report a healthy-ish quiet input forever while the stream
     * was gone. Only the AGE of the last frame can tell the difference.
     */
    const heard = feed(INITIAL_MIC_CHECK_STATE, 5, 1000, () => ({
      rms: 0.05,
      peak: 0.08,
      speaking: false,
      signalPresent: true,
    }));
    const lastAtMs = 1000 + 4 * FRAME_MS;
    const stale = frame({ generatedAtMs: lastAtMs, signalPresent: true, speaking: false });
    expect(micCheckView(heard, stale, lastAtMs + NO_SIGNAL_AFTER_MS, 1000).state).toBe('unheard');
  });

  it('keeps reporting a pass even after the capture is torn down', () => {
    /*
     * The capture is released the moment a pass settles, so the last frame ages
     * past the staleness bound while "your microphone is working" is still on
     * screen. With staleness checked ahead of the latch, a successful check
     * spent its final moments accusing the microphone it had just approved.
     */
    const heard = feed(INITIAL_MIC_CHECK_STATE, 20, 1000, speaking);
    expect(heard.passed).toBe(true);
    const longAfter = 1000 + 20 * FRAME_MS + NO_SIGNAL_AFTER_MS * 4;
    expect(micCheckView(heard, null, longAfter, 1000).state).toBe('passed');
  });

  it('still says "say something" during the first moments of silence', () => {
    // A gap between words, or simply not having started yet, must not be
    // reported as a broken microphone.
    const view = micCheckView(INITIAL_MIC_CHECK_STATE, null, 1000 + 500, 1000);
    expect(view.state).toBe('waiting');
  });

  it('names a clipped signal rather than passing it', () => {
    const hot = () => ({ rms: 0.9, peak: 1, speaking: true, clipped: true, signalPresent: true });
    const state = feed(INITIAL_MIC_CHECK_STATE, 3, 1000, hot);
    const nowMs = 1000 + 3 * FRAME_MS;
    const view = micCheckView(state, frame({ ...hot(), generatedAtMs: nowMs }), nowMs, 1000);
    expect(view.state).toBe('clipping');
  });

  it('reports a pass, whatever the last frame happened to be', () => {
    const heard = feed(INITIAL_MIC_CHECK_STATE, 20, 1000, speaking);
    const nowMs = 1000 + 20 * FRAME_MS;
    // Last frame is silence — the presenter stopped talking. Still a pass.
    const view = micCheckView(heard, frame({ ...silent(), generatedAtMs: nowMs }), nowMs, 1000);
    expect(view.state).toBe('passed');
    expect(view.headline).toMatch(/working/i);
  });
});

describe('the waveform trace', () => {
  it('is bounded, so a long check cannot grow the payload without limit', () => {
    const state = feed(INITIAL_MIC_CHECK_STATE, MIC_CHECK_TRACE_SAMPLES * 3, 1000, speaking);
    expect(state.levels).toHaveLength(MIC_CHECK_TRACE_SAMPLES);
  });

  it('normalises an ordinary voice into a readable amplitude', () => {
    /*
     * Raw RMS at conversational distance is ~0.05–0.15. Drawn as a straight
     * percentage that is a flat line, so the app looks deaf while hearing
     * perfectly well — the same trap the Preflight meter documents.
     */
    const ordinary = () => ({ rms: 0.1, peak: 0.18, speaking: true, signalPresent: true });
    const state = feed(INITIAL_MIC_CHECK_STATE, 10, 1000, ordinary);
    const last = state.levels.at(-1) ?? 0;
    expect(last).toBeGreaterThan(0.2);
    expect(last).toBeLessThanOrEqual(1);
  });

  it('keeps every amplitude inside 0–1 even when the input clips', () => {
    const hot = () => ({ rms: 4, peak: 4, speaking: true, clipped: true, signalPresent: true });
    const state = feed(INITIAL_MIC_CHECK_STATE, 5, 1000, hot);
    for (const level of state.levels) {
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(1);
    }
  });
});

describe('the override', () => {
  it('is not offered immediately', () => {
    // Instantly skippable would make it the button you press to make the
    // screen go away, restoring the failure the check exists to prevent.
    expect(micCheckCanOverride(0)).toBe(false);
    expect(micCheckCanOverride(MIC_CHECK_OVERRIDE_AFTER_MS - 1)).toBe(false);
  });

  it('is offered once the presenter has had time to try', () => {
    expect(micCheckCanOverride(MIC_CHECK_OVERRIDE_AFTER_MS)).toBe(true);
  });

  it('appears in the view on the same schedule', () => {
    const early = micCheckView(INITIAL_MIC_CHECK_STATE, null, 1000, 1000);
    const later = micCheckView(
      INITIAL_MIC_CHECK_STATE,
      null,
      1000 + MIC_CHECK_OVERRIDE_AFTER_MS,
      1000,
    );
    expect(early.canOverride).toBe(false);
    expect(later.canOverride).toBe(true);
  });
});
