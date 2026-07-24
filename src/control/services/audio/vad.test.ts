import { describe, expect, it } from 'vitest';
import { computeFrameStats, LocalVad, type VadEvent } from './vad';
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
    const events = feed(vad, t, 2000, 0.005); // above ambient but below minSpeechRms
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
