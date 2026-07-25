import { describe, expect, it } from 'vitest';
import { computeFrameStats, estimateNoiseFloor, LocalVad, type VadEvent } from './vad';
import { DEFAULT_VAD_CONFIG } from './defaults';

const FRAME_MS = 50;

/** Drive the VAD with a constant RMS level for a duration. */
function feed(vad: LocalVad, startMs: number, durationMs: number, rms: number, peak = rms): VadEvent[] {
  const events: VadEvent[] = [];
  for (let t = startMs; t < startMs + durationMs; t += FRAME_MS) {
    events.push(...vad.processFrame({ rms, peak }, t));
  }
  return events;
}

function calibrated(vad: LocalVad): number {
  // Quiet ambient for the full calibration window.
  const events = feed(vad, 0, DEFAULT_VAD_CONFIG.calibrationMs + FRAME_MS, 0.002);
  expect(events.some((e) => e.type === 'calibrated')).toBe(true);
  return DEFAULT_VAD_CONFIG.calibrationMs + FRAME_MS;
}

describe('computeFrameStats', () => {
  it('computes rms and peak', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0]);
    const stats = computeFrameStats(samples);
    expect(stats.peak).toBe(0.5);
    expect(stats.rms).toBeCloseTo(Math.sqrt(0.125), 5);
  });

  it('handles empty frames', () => {
    expect(computeFrameStats(new Float32Array(0))).toEqual({ rms: 0, peak: 0 });
  });
});

describe('LocalVad (spec §28.4, A.6 defaults)', () => {
  it('calibrates a noise floor from the initial window', () => {
    const vad = new LocalVad();
    const events = feed(vad, 0, DEFAULT_VAD_CONFIG.calibrationMs + FRAME_MS, 0.002);
    const cal = events.find((e) => e.type === 'calibrated');
    expect(cal).toBeDefined();
    expect(vad.noiseFloor).toBeCloseTo(0.002, 3);
  });

  it('opens speech only after the configured open duration', () => {
    const vad = new LocalVad();
    let t = calibrated(vad);
    // One loud frame alone must not open speech (100 ms required).
    let events = feed(vad, t, FRAME_MS, 0.2);
    expect(events.some((e) => e.type === 'speech_started')).toBe(false);
    t += FRAME_MS;
    events = feed(vad, t, 3 * FRAME_MS, 0.2);
    expect(events.some((e) => e.type === 'speech_started')).toBe(true);
    expect(vad.speaking).toBe(true);
  });

  it('survives short gaps and closes after end-of-turn silence', () => {
    const vad = new LocalVad();
    let t = calibrated(vad);
    feed(vad, t, 500, 0.2);
    t += 500;
    // Short gap (200 ms < 420 ms) must not close the turn.
    feed(vad, t, 200, 0.002);
    t += 200;
    expect(vad.speaking).toBe(true);
    feed(vad, t, 300, 0.2);
    t += 300;
    // Full end-of-turn silence closes the turn exactly once.
    const events = feed(vad, t, DEFAULT_VAD_CONFIG.endOfTurnSilenceMs + 2 * FRAME_MS, 0.002);
    const ended = events.filter((e) => e.type === 'speech_ended');
    expect(ended).toHaveLength(1);
    expect(vad.speaking).toBe(false);
  });

  it('reports speech start time from when the level first rose', () => {
    const vad = new LocalVad();
    const t = calibrated(vad);
    const events = feed(vad, t, 300, 0.2);
    const started = events.find((e) => e.type === 'speech_started');
    expect(started).toBeDefined();
    expect((started as Extract<VadEvent, { type: 'speech_started' }>).atMs).toBe(t);
  });

  it('forces max_utterance after continuous speech reaches the cap', () => {
    const vad = new LocalVad();
    const t = calibrated(vad);
    const events = feed(vad, t, DEFAULT_VAD_CONFIG.maxUtteranceMs + 500, 0.2);
    const forced = events.filter((e) => e.type === 'max_utterance');
    expect(forced).toHaveLength(1);
    expect(vad.speaking).toBe(true); // speech continues after forced commit
  });

  it('re-anchors after max_utterance so the next forced commit is another full window later', () => {
    const vad = new LocalVad();
    const t = calibrated(vad);
    const events = feed(vad, t, 2 * DEFAULT_VAD_CONFIG.maxUtteranceMs + 500, 0.2);
    expect(events.filter((e) => e.type === 'max_utterance')).toHaveLength(2);
  });

  it('never opens speech for noise-only levels below the absolute floor', () => {
    const vad = new LocalVad();
    const t = calibrated(vad);
    /*
     * Derived from the config, not hard-coded. This read `0.005`, which was
     * below the absolute floor when that floor was 0.01 and above it once the
     * defaults were retuned for far-field speech — so a tuning change silently
     * inverted what the test was asserting while it still looked like it
     * passed for its stated reason.
     */
    const belowFloor = DEFAULT_VAD_CONFIG.minSpeechRms / 2;
    const events = feed(vad, t, 2000, belowFloor);
    expect(events.some((e) => e.type === 'speech_started')).toBe(false);
  });

  it('produces level snapshots with clipping and signal flags', () => {
    const vad = new LocalVad();
    vad.processFrame({ rms: 0.4, peak: 0.999 }, 0);
    const clippedSnap = vad.getSnapshot();
    expect(clippedSnap?.clipped).toBe(true);
    expect(clippedSnap?.signalPresent).toBe(true);
    vad.processFrame({ rms: 0.0001, peak: 0.0002 }, 50);
    const silent = vad.getSnapshot();
    expect(silent?.clipped).toBe(false);
    expect(silent?.signalPresent).toBe(false);
    expect(silent?.generatedAtMs).toBe(50);
  });
});

describe('calibration cannot be poisoned by the presenter speaking', () => {
  /*
   * Reproduced from a real take, from the numbers the trace recorded:
   *
   *   level — rms 0.1198 peak 0.3581 signal true    (the presenter, reading)
   *   vad   — calibrated — noiseFloor 0.1008, gate 0.2520
   *   level — rms 0.0376 … 0.0498 …                 (still reading)
   *   ...and `speaking false` for the rest of a 24-second take.
   *
   * The floor was the presenter's voice, so the gate landed above every word
   * they said afterwards. Nothing was ever committed and nothing was ever
   * transcribed, on a connection that was in perfect health. Ambient room tone
   * measures 0.0003-0.003; a "floor" of 0.1008 was never a room.
   */
  const SPEECH_RMS = 0.12;
  const QUIET_RMS = 0.002;

  it('finds the room underneath speech that has gaps in it', () => {
    // A presenter reading: loud on words, near-ambient between them. The mean
    // of this is speech; the low percentile is the room.
    const frames: number[] = [];
    for (let i = 0; i < 40; i += 1) frames.push(i % 3 === 0 ? QUIET_RMS : SPEECH_RMS);

    const floor = estimateNoiseFloor(frames, DEFAULT_VAD_CONFIG);
    const mean = frames.reduce((a, b) => a + b, 0) / frames.length;

    expect(floor).toBeLessThanOrEqual(QUIET_RMS);
    expect(mean, 'the old estimator would have returned this').toBeGreaterThan(0.05);
  });

  it('refuses to believe a floor that is obviously a voice', () => {
    // The unsaveable case: continuous speech, no gaps at all. There is no
    // measurement of the room in this window, so the ceiling is what stops a
    // voice being recorded as ambient.
    const frames = Array.from({ length: 40 }, () => SPEECH_RMS);
    const floor = estimateNoiseFloor(frames, DEFAULT_VAD_CONFIG);

    expect(floor).toBe(DEFAULT_VAD_CONFIG.maxNoiseFloor);
    // And the gate it produces must still be clearable by ordinary speech,
    // which is the whole point — 0.02 * 2.5 = 0.05, under the 0.03-0.12 the
    // trace recorded.
    const gate = Math.max(
      DEFAULT_VAD_CONFIG.minSpeechRms,
      floor * DEFAULT_VAD_CONFIG.noiseFloorMargin,
    );
    expect(gate).toBeLessThan(0.06);
  });

  it('hears speech that follows a calibration window full of speech', () => {
    /*
     * End to end through the real VAD, with the take that failed: two seconds
     * of the presenter already reading, then more reading. Before the fix this
     * produced no `speech_started` for the rest of the session.
     */
    const vad = new LocalVad();
    const events: VadEvent[] = [];
    let at = 0;
    const feedFrames = (rms: number, ms: number): void => {
      for (let t = 0; t < ms; t += FRAME_MS) {
        events.push(...vad.processFrame({ rms, peak: rms * 3 }, at));
        at += FRAME_MS;
      }
    };

    feedFrames(SPEECH_RMS, DEFAULT_VAD_CONFIG.calibrationMs + FRAME_MS);
    expect(events.some((e) => e.type === 'calibrated')).toBe(true);

    feedFrames(SPEECH_RMS, 600);
    expect(
      events.some((e) => e.type === 'speech_started'),
      'the presenter kept reading and must be heard',
    ).toBe(true);

    // And a pause must close the turn, because `speech_ended` is the commit
    // cue — speech that opens and never closes still transcribes nothing.
    feedFrames(QUIET_RMS, DEFAULT_VAD_CONFIG.endOfTurnSilenceMs + 200);
    expect(events.some((e) => e.type === 'speech_ended')).toBe(true);
  });
});
