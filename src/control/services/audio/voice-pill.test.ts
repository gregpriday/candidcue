/**
 * The voice pill reports on a take that is already running, which flips the
 * risk profile of everything it decides. The old microphone check could refuse
 * to start; this cannot refuse anything, so the failure that matters is not
 * "it let a bad session through" but "it interrupted a good one".
 *
 * Two properties are therefore load-bearing and each has its own tests:
 *
 *   • it never cries wolf. Silence between sentences, a pause, the seconds
 *     before the first word — none of those are faults, and a cross on the
 *     corner of the stage during an otherwise perfect take is worse than no
 *     indicator at all, because the presenter will look at it;
 *   • it does not go quiet when the session actually breaks. A dead capture, a
 *     socket returning nothing — those are the failures the whole idea exists
 *     for, and the pill has to say so without being asked.
 */
import { describe, expect, it } from 'vitest';
import type { AudioLevelSnapshot } from '../../../shared/contracts';
import {
  VOICE_PILL_CONFIRM_HOLD_MS,
  VOICE_PILL_NO_CAPTURE_MS,
  VOICE_PILL_STALE_FRAME_MS,
  VOICE_PILL_TRACE_SAMPLES,
  VOICE_PILL_UNHEARD_SPEECH_MS,
  initialVoicePillState,
  reduceVoicePillLevel,
  reduceVoicePillText,
  tickVoicePill,
  voicePillView,
  type VoicePillConditions,
  type VoicePillState,
} from './voice-pill';

/** A frame at the ~90 ms analysis cadence. */
const FRAME_MS = 90;
/** Well above zero, so "no frame yet" cannot pass by coincidence. */
const START_MS = 5000;

const HEALTHY: VoicePillConditions = {
  deviceLost: false,
  transportOffline: false,
  suspended: false,
};
const DEVICE_LOST: VoicePillConditions = { ...HEALTHY, deviceLost: true };
const PAUSED: VoicePillConditions = { ...HEALTHY, suspended: true };
const OFFLINE: VoicePillConditions = { ...HEALTHY, transportOffline: true };

function frame(overrides: Partial<AudioLevelSnapshot> = {}): AudioLevelSnapshot {
  return {
    rms: 0.28,
    peak: 0.45,
    noiseFloor: 0.02,
    speaking: true,
    clipped: false,
    signalPresent: true,
    generatedAtMs: 0,
    ...overrides,
  };
}

/** Feed `count` frames from `startMs`, `FRAME_MS` apart. */
function feed(
  state: VoicePillState,
  count: number,
  startMs: number,
  overrides: Partial<AudioLevelSnapshot> = {},
): VoicePillState {
  let next = state;
  for (let i = 0; i < count; i += 1) {
    const atMs = startMs + i * FRAME_MS;
    next = reduceVoicePillLevel(next, frame({ ...overrides, generatedAtMs: atMs }), atMs);
  }
  return next;
}

function reading(state: VoicePillState, nowMs: number, conditions = HEALTHY): string {
  return tickVoicePill(state, conditions, nowMs).reading;
}

describe('listening — the ordinary state, which must stay ordinary', () => {
  it('says nothing is wrong before the first frame arrives', () => {
    /*
     * The window between the take opening and `getUserMedia` returning is not a
     * fault, it is a device being acquired — ~900 ms uncontended, and slower
     * behind a permission prompt.
     */
    const state = initialVoicePillState(START_MS);
    expect(reading(state, START_MS + 500)).toBe('listening');
    expect(reading(state, START_MS + VOICE_PILL_NO_CAPTURE_MS - 1)).toBe('listening');
  });

  it('waits through a long silence without accusing the microphone', () => {
    /*
     * The regression this file exists for. The check this replaced reported
     * "CandidCue cannot hear that microphone" after 2.5 s of silence — which is
     * how long it takes to read the sentence asking you to speak. Frames are
     * ARRIVING here; nobody is talking. That is a presenter thinking, and it is
     * not news.
     */
    const state = feed(initialVoicePillState(START_MS), 200, START_MS, {
      rms: 0,
      peak: 0,
      speaking: false,
      signalPresent: false,
    });
    const lastAtMs = START_MS + 199 * FRAME_MS;
    expect(lastAtMs - START_MS).toBeGreaterThan(VOICE_PILL_UNHEARD_SPEECH_MS * 4);
    expect(reading(state, lastAtMs)).toBe('listening');
  });

  it('does not treat a single loud frame as anything at all', () => {
    // Clipping is Preflight's business. Mid-take there is nothing the presenter
    // can do about it, and a cross for one plosive is pure interruption.
    const state = feed(initialVoicePillState(START_MS), 3, START_MS, { clipped: true, peak: 1 });
    expect(reading(state, START_MS + 2 * FRAME_MS)).toBe('listening');
  });
});

describe('confirming', () => {
  it('turns into a tick as soon as recogniser text comes back', () => {
    const heard = reduceVoicePillText(feed(initialVoicePillState(START_MS), 5, START_MS), 'hello');
    expect(reading(heard, START_MS + 5 * FRAME_MS)).toBe('confirmed');
  });

  it('ignores the empty partials the transport emits while an utterance opens', () => {
    // Confirming on those would put a tick on a session that has transcribed
    // nothing — the exact claim the pill is not allowed to make falsely.
    const state = reduceVoicePillText(feed(initialVoicePillState(START_MS), 5, START_MS), '   ');
    expect(reading(state, START_MS + 5 * FRAME_MS)).toBe('listening');
  });

  it('stays confirmed once it has been confirmed', () => {
    // The presenter falling silent after proving the chain works is not
    // evidence against it.
    let state = reduceVoicePillText(feed(initialVoicePillState(START_MS), 5, START_MS), 'hello');
    state = tickVoicePill(state, HEALTHY, START_MS + 5 * FRAME_MS);
    const later = feed(state, 20, START_MS + 6 * FRAME_MS, {
      rms: 0,
      peak: 0,
      speaking: false,
      signalPresent: false,
    });
    expect(reading(later, START_MS + 25 * FRAME_MS)).toBe('confirmed');
  });

  it('fades away once the confirmation has been on screen long enough', () => {
    let state = reduceVoicePillText(feed(initialVoicePillState(START_MS), 5, START_MS), 'hello');
    const confirmedAtMs = START_MS + 5 * FRAME_MS;
    state = tickVoicePill(state, HEALTHY, confirmedAtMs);
    expect(voicePillView(state, confirmedAtMs).visible).toBe(true);
    expect(voicePillView(state, confirmedAtMs + VOICE_PILL_CONFIRM_HOLD_MS - 1).visible).toBe(true);
    expect(voicePillView(state, confirmedAtMs + VOICE_PILL_CONFIRM_HOLD_MS).visible).toBe(false);
  });

  it('comes back, and stays for a full hold, after a fault resolves', () => {
    /*
     * "Fades once proven, returns on trouble" only works if the recovery gets
     * its own hold. Inheriting the expired one would make the pill flash on for
     * the fault and vanish the instant it was fixed — the presenter would see
     * the problem and never the resolution.
     */
    let state = reduceVoicePillText(feed(initialVoicePillState(START_MS), 5, START_MS), 'hello');
    const confirmedAtMs = START_MS + 5 * FRAME_MS;
    state = tickVoicePill(state, HEALTHY, confirmedAtMs);
    const faultedAtMs = confirmedAtMs + VOICE_PILL_CONFIRM_HOLD_MS + 1000;
    state = tickVoicePill(state, DEVICE_LOST, faultedAtMs);
    expect(state.reading).toBe('fault');
    expect(voicePillView(state, faultedAtMs).visible).toBe(true);

    // Feed a frame so the capture does not read as stale, then recover.
    const backAtMs = faultedAtMs + 500;
    state = reduceVoicePillLevel(state, frame({ generatedAtMs: backAtMs }), backAtMs);
    state = tickVoicePill(state, HEALTHY, backAtMs);
    expect(state.reading).toBe('confirmed');
    expect(voicePillView(state, backAtMs + VOICE_PILL_CONFIRM_HOLD_MS - 1).visible).toBe(true);
  });
});

describe('faults — the two it can actually see', () => {
  it('reports no audio when the level frames stop arriving', () => {
    /*
     * Frames arrive whether or not anyone is speaking: the monitor reads the
     * analyser on a timer. A gap this long is a graph that has stopped being
     * pulled, not a quiet room.
     */
    const state = feed(initialVoicePillState(START_MS), 10, START_MS);
    const lastAtMs = START_MS + 9 * FRAME_MS;
    expect(reading(state, lastAtMs + VOICE_PILL_STALE_FRAME_MS - 1)).not.toBe('fault');
    const stalled = tickVoicePill(state, HEALTHY, lastAtMs + VOICE_PILL_STALE_FRAME_MS);
    expect(stalled.reading).toBe('fault');
    expect(stalled.fault).toBe('no_audio');
  });

  it('reports no audio when no frame ever arrives at all', () => {
    // Permission refused below the app, the device held by something else: the
    // pill is the only thing on screen that can say so.
    const state = initialVoicePillState(START_MS);
    const late = tickVoicePill(state, HEALTHY, START_MS + VOICE_PILL_NO_CAPTURE_MS);
    expect(late.reading).toBe('fault');
    expect(late.fault).toBe('no_audio');
  });

  it('reports a device the session says has gone', () => {
    const state = feed(initialVoicePillState(START_MS), 10, START_MS);
    const lastAtMs = START_MS + 9 * FRAME_MS;
    const lost = tickVoicePill(state, DEVICE_LOST, lastAtMs);
    expect(lost.reading).toBe('fault');
    expect(lost.fault).toBe('no_audio');
  });

  it('reports a transport that has given up, even with nobody speaking', () => {
    /*
     * A pill that had already confirmed and faded would otherwise sit silently
     * confirmed over a dead socket until four more seconds of SPEECH happened
     * to accumulate — and if the presenter had stopped talking, forever. The
     * take is not being transcribed; that is exactly what this reports.
     */
    let state = reduceVoicePillText(feed(initialVoicePillState(START_MS), 10, START_MS), 'hello');
    const lastAtMs = START_MS + 9 * FRAME_MS;
    state = tickVoicePill(state, HEALTHY, lastAtMs);
    expect(state.reading).toBe('confirmed');
    const offline = tickVoicePill(state, OFFLINE, lastAtMs);
    expect(offline.reading).toBe('fault');
    expect(offline.fault).toBe('offline');
    expect(voicePillView(offline, lastAtMs).visible).toBe(true);
  });

  it('reports speech that nothing comes back from', () => {
    /*
     * The failure the whole idea exists for: the microphone works, the waveform
     * moves, and the script does not follow because the socket is returning
     * nothing. Counted in SPEECH, so a presenter who is simply not talking can
     * never reach it.
     */
    const frames = Math.ceil(VOICE_PILL_UNHEARD_SPEECH_MS / FRAME_MS) + 2;
    const state = feed(initialVoicePillState(START_MS), frames, START_MS);
    const lastAtMs = START_MS + (frames - 1) * FRAME_MS;
    expect(state.speechSinceTextMs).toBeGreaterThanOrEqual(VOICE_PILL_UNHEARD_SPEECH_MS);
    const unheard = tickVoicePill(state, HEALTHY, lastAtMs);
    expect(unheard.reading).toBe('fault');
    expect(unheard.fault).toBe('not_heard');
  });

  it('clears the unheard fault the moment words arrive', () => {
    const frames = Math.ceil(VOICE_PILL_UNHEARD_SPEECH_MS / FRAME_MS) + 2;
    let state = feed(initialVoicePillState(START_MS), frames, START_MS);
    const lastAtMs = START_MS + (frames - 1) * FRAME_MS;
    state = tickVoicePill(state, HEALTHY, lastAtMs);
    expect(state.reading).toBe('fault');
    state = reduceVoicePillText(state, 'the words finally came back');
    expect(reading(state, lastAtMs)).toBe('confirmed');
  });

  it('does not credit a stalled stream as speech', () => {
    /*
     * Frames seconds apart are not seconds of speech. Without the credit cap a
     * dead capture would accumulate the unheard threshold from a handful of
     * surviving frames and report the wrong fault — "not hearing you" for a
     * microphone that has stopped delivering audio entirely.
     */
    let state = initialVoicePillState(START_MS);
    for (let i = 0; i < 6; i += 1) {
      const atMs = START_MS + i * 3000;
      state = reduceVoicePillLevel(state, frame({ generatedAtMs: atMs }), atMs);
    }
    expect(state.speechSinceTextMs).toBe(0);
  });

  it('says nothing at all while the take is paused', () => {
    /*
     * A soft pause captures audio and deliberately stops sending it. A
     * presenter who pauses and keeps talking would otherwise accumulate the
     * unheard threshold and be told the app cannot hear them — while it was
     * doing exactly what they asked.
     */
    const frames = Math.ceil(VOICE_PILL_UNHEARD_SPEECH_MS / FRAME_MS) + 2;
    const state = feed(initialVoicePillState(START_MS), frames, START_MS);
    const lastAtMs = START_MS + (frames - 1) * FRAME_MS;
    const paused = tickVoicePill(state, { ...DEVICE_LOST, suspended: true }, lastAtMs);
    expect(paused.reading).toBe('listening');
    // And the clock is reset, so resuming does not fault a moment later.
    expect(paused.speechSinceTextMs).toBe(0);
    /*
     * It also shows nothing at all: a hard pause has muted the microphone, so
     * "Listening" would be a claim about a device that is switched off.
     */
    expect(voicePillView(paused, lastAtMs).visible).toBe(false);
  });
});

describe('coming back from a pause', () => {
  it('shows the recovery instead of spending it behind the pause', () => {
    /*
     * A fault that clears while the pill is hidden must not consume its own
     * confirm-hold. Resolving readings during a pause did exactly that: the
     * presenter went for a ten-second break with a cross on screen, came back
     * to a working session, and was shown nothing at all — the pill had
     * transitioned to confirmed at second one of the pause and expired at
     * second 3.5, invisibly.
     */
    let state = reduceVoicePillText(feed(initialVoicePillState(START_MS), 10, START_MS), 'hello');
    const faultedAtMs = START_MS + 10 * FRAME_MS;
    state = tickVoicePill(state, DEVICE_LOST, faultedAtMs);
    expect(state.reading).toBe('fault');

    // Paused, and the device comes back during the pause.
    const pausedAtMs = faultedAtMs + 100;
    state = tickVoicePill(state, { ...DEVICE_LOST, suspended: true }, pausedAtMs);
    expect(state.reading).toBe('fault'); // frozen, not re-resolved
    const stillPausedAtMs = pausedAtMs + 10_000;
    state = tickVoicePill(state, PAUSED, stillPausedAtMs);
    expect(voicePillView(state, stillPausedAtMs).visible).toBe(false);

    // Resumed: the recovery happens where it can be seen, with a full hold.
    const resumedAtMs = stillPausedAtMs + 100;
    state = tickVoicePill(state, HEALTHY, resumedAtMs);
    expect(state.reading).toBe('confirmed');
    expect(voicePillView(state, resumedAtMs + VOICE_PILL_CONFIRM_HOLD_MS - 1).visible).toBe(true);
  });

  it('does not accuse the microphone while the capture is being reopened', () => {
    /*
     * A hard pause tears the capture down, so no frames arrive until
     * `getUserMedia` has returned. Judged against the stale-frame bound that
     * is a cross on screen for the second the pipeline needs — so the pause
     * rebases the generous first-frame window instead.
     */
    let state = feed(initialVoicePillState(START_MS), 10, START_MS);
    const pausedAtMs = START_MS + 10 * FRAME_MS;
    state = tickVoicePill(state, PAUSED, pausedAtMs);
    const resumedAtMs = pausedAtMs + 60_000;
    state = tickVoicePill(state, HEALTHY, resumedAtMs);
    expect(state.reading).toBe('listening');
    // ...and it still gives up eventually if the capture never comes back.
    const laterAtMs = resumedAtMs + VOICE_PILL_NO_CAPTURE_MS;
    expect(tickVoicePill(state, HEALTHY, laterAtMs).fault).toBe('no_audio');
  });
});

describe('the waveform trace', () => {
  it('is bounded, so a long take cannot grow the payload without limit', () => {
    const state = feed(initialVoicePillState(START_MS), VOICE_PILL_TRACE_SAMPLES * 4, START_MS);
    expect(state.levels).toHaveLength(VOICE_PILL_TRACE_SAMPLES);
  });

  it('normalises an ordinary voice into a readable amplitude', () => {
    // Raw RMS from a typical microphone sits around 0.05–0.15. Drawn straight
    // it is a flat line that says "we cannot hear you" while the input is fine.
    const state = feed(initialVoicePillState(START_MS), 5, START_MS, { rms: 0.1, peak: 0.2 });
    const drawn = state.levels.at(-1) ?? 0;
    expect(drawn).toBeGreaterThan(0.2);
    expect(drawn).toBeLessThanOrEqual(1);
  });

  it('keeps every amplitude inside 0–1 even when the input clips', () => {
    const state = feed(initialVoicePillState(START_MS), 5, START_MS, { rms: 4, peak: 4 });
    for (const level of state.levels) {
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(1);
    }
  });
});

describe('malformed frames', () => {
  it('ignores a frame carrying NaN rather than poisoning the state', () => {
    /*
     * NaN compares false against every threshold, so folding one in disables
     * the fault detectors rather than tripping them — the pill would sit on
     * "listening" through a capture that had died.
     */
    const good = feed(initialVoicePillState(START_MS), 5, START_MS);
    const bad = reduceVoicePillLevel(
      good,
      frame({ rms: Number.NaN, peak: Number.NaN, generatedAtMs: START_MS + 500 }),
      START_MS + 500,
    );
    expect(bad).toBe(good);
    // And the dropped frame did not advance the clock, so a stream producing
    // nothing but garbage still ages into a fault.
    expect(bad.lastFrameAtMs).toBe(START_MS + 4 * FRAME_MS);
  });

  it('ignores a frame whose timestamp goes backwards', () => {
    const good = feed(initialVoicePillState(START_MS), 5, START_MS);
    const late = reduceVoicePillLevel(good, frame({ generatedAtMs: START_MS }), START_MS);
    expect(late).toBe(good);
  });
});

describe('what the presenter is told', () => {
  it('names every state in words, never in colour alone', () => {
    const state = initialVoicePillState(START_MS);
    expect(voicePillView(state, START_MS).label).toBe('Listening');

    const heard = tickVoicePill(reduceVoicePillText(state, 'hello'), HEALTHY, START_MS);
    expect(voicePillView(heard, START_MS).label).toBe('Hearing you');

    const dead = tickVoicePill(state, DEVICE_LOST, START_MS);
    expect(voicePillView(dead, START_MS).label).toBe('No audio');

    const offline = tickVoicePill(reduceVoicePillText(state, 'hi'), OFFLINE, START_MS);
    expect(voicePillView(offline, START_MS).label).toBe('Not connected');

    const frames = Math.ceil(VOICE_PILL_UNHEARD_SPEECH_MS / FRAME_MS) + 2;
    const talking = feed(initialVoicePillState(START_MS), frames, START_MS);
    const lastAtMs = START_MS + (frames - 1) * FRAME_MS;
    expect(voicePillView(tickVoicePill(talking, HEALTHY, lastAtMs), lastAtMs).label).toBe(
      'Not hearing you',
    );
  });
});
