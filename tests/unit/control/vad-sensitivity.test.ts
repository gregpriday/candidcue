/**
 * §28.4 "Local voice-detection sensitivity" — the slider that had no reader.
 *
 * `vadSensitivity` was persisted from the day the setting shipped and nothing
 * ever consumed it: every session ran on `DEFAULT_VAD_CONFIG`. These tests
 * assert the three things that make it a real control rather than a decoration:
 *
 *  1. moving it changes what the VAD calls speech — at one level of input, one
 *     end of the slider opens a turn and the other does not;
 *  2. the midpoint is EXACTLY the A.6 defaults, so nobody's existing sessions
 *     were retuned by wiring it up;
 *  3. the bound holds at both extremes — the commit cadence fields
 *     (`endOfTurnSilenceMs`, `maxUtteranceMs`, `calibrationMs`) are untouched at
 *     0 and at 1, because they are transcription latency and money, not
 *     detection.
 *
 * On revert (1) fails outright: both ends behave identically because the config
 * never reaches the VAD.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VAD_CONFIG,
  VAD_SENSITIVITY_BOUNDS,
  vadConfigForSensitivity,
} from '../../../src/control/services/audio/defaults';
import { LocalVad, type VadEvent } from '../../../src/control/services/audio/vad';

const FRAME_MS = 50;

function feed(vad: LocalVad, startMs: number, durationMs: number, rms: number): VadEvent[] {
  const events: VadEvent[] = [];
  for (let t = startMs; t < startMs + durationMs; t += FRAME_MS) {
    events.push(...vad.processFrame({ rms, peak: rms }, t));
  }
  return events;
}

/**
 * Calibrate against a fixed ambient floor, then hold `speechRms` for long
 * enough to open a turn. Returns whether the VAD called it speech.
 */
function opensSpeechAt(sensitivity: number, ambientRms: number, speechRms: number): boolean {
  const vad = new LocalVad(vadConfigForSensitivity(sensitivity));
  feed(vad, 0, DEFAULT_VAD_CONFIG.calibrationMs + FRAME_MS, ambientRms);
  const events = feed(
    vad,
    DEFAULT_VAD_CONFIG.calibrationMs + FRAME_MS,
    DEFAULT_VAD_CONFIG.speechOpenMs + 4 * FRAME_MS,
    speechRms,
  );
  return events.some((e) => e.type === 'speech_started');
}

describe('vadConfigForSensitivity (§28.4)', () => {
  it('leaves the A.6 defaults exactly at the midpoint', () => {
    const mid = vadConfigForSensitivity(0.5);
    expect(mid.noiseFloorMargin).toBeCloseTo(DEFAULT_VAD_CONFIG.noiseFloorMargin, 10);
    expect(mid.minSpeechRms).toBeCloseTo(DEFAULT_VAD_CONFIG.minSpeechRms, 10);
  });

  it('moves the threshold monotonically across the slider', () => {
    const margins = [0, 0.25, 0.5, 0.75, 1].map(
      (s) => vadConfigForSensitivity(s).noiseFloorMargin as number,
    );
    for (let i = 1; i < margins.length; i++) {
      expect(margins[i]).toBeLessThan(margins[i - 1] as number);
    }
    expect(margins[0]).toBeCloseTo(VAD_SENSITIVITY_BOUNDS.marginAtMin, 10);
    expect(margins[margins.length - 1]).toBeCloseTo(VAD_SENSITIVITY_BOUNDS.marginAtMax, 10);
  });

  /* ------------------------------------------------------- the bound holds */

  it('never touches the commit-cadence fields, at either extreme', () => {
    for (const sensitivity of [0, 0.25, 0.5, 0.75, 1]) {
      const config = vadConfigForSensitivity(sensitivity) as Record<string, unknown>;
      // These three decide how often a turn closes, and every close is a
      // Realtime commit — a billable round trip, not just a detection event.
      expect(config.endOfTurnSilenceMs).toBeUndefined();
      expect(config.maxUtteranceMs).toBeUndefined();
      expect(config.calibrationMs).toBeUndefined();
      // The slider returns thresholds and nothing else.
      expect(Object.keys(config).sort()).toEqual(['minSpeechRms', 'noiseFloorMargin']);
    }
  });

  it('applies the full config with the untouched cadence intact at both ends', () => {
    for (const sensitivity of [0, 1]) {
      const vad = new LocalVad(vadConfigForSensitivity(sensitivity));
      feed(vad, 0, DEFAULT_VAD_CONFIG.calibrationMs + FRAME_MS, 0.002);
      // Loud speech opens at every slider position...
      const opened = feed(vad, 3_000, DEFAULT_VAD_CONFIG.speechOpenMs + FRAME_MS, 0.4);
      expect(opened.some((e) => e.type === 'speech_started')).toBe(true);
      // ...and closes on the unchanged 420 ms of silence, not sooner or later.
      const early = feed(vad, 4_000, DEFAULT_VAD_CONFIG.endOfTurnSilenceMs - 3 * FRAME_MS, 0.001);
      expect(early.some((e) => e.type === 'speech_ended')).toBe(false);
      const closed = feed(vad, 4_400, 4 * FRAME_MS, 0.001);
      expect(closed.some((e) => e.type === 'speech_ended')).toBe(true);
    }
  });

  it('clamps out-of-range input and falls back to neutral on nonsense', () => {
    expect(vadConfigForSensitivity(-5).noiseFloorMargin).toBeCloseTo(
      VAD_SENSITIVITY_BOUNDS.marginAtMin,
      10,
    );
    expect(vadConfigForSensitivity(9).noiseFloorMargin).toBeCloseTo(
      VAD_SENSITIVITY_BOUNDS.marginAtMax,
      10,
    );
    // A corrupt setting must not become the most aggressive VAD available.
    expect(vadConfigForSensitivity(Number.NaN).noiseFloorMargin).toBeCloseTo(
      DEFAULT_VAD_CONFIG.noiseFloorMargin,
      10,
    );
  });
});

describe('LocalVad honours the sensitivity (§28.4)', () => {
  /**
   * The load-bearing test. Ambient 0.004, speech at 0.009 — a quiet talker in a
   * quiet room, sitting between the two ends of the slider's threshold band.
   */
  const ambient = 0.004;
  const quietSpeech = 0.009;

  it('the most sensitive end hears speech the least sensitive end does not', () => {
    expect(opensSpeechAt(1, ambient, quietSpeech)).toBe(true);
    expect(opensSpeechAt(0, ambient, quietSpeech)).toBe(false);
  });

  it('the default sits inside the band, so both directions are usable', () => {
    // Loud enough for everyone, quiet enough for nobody — the slider has real
    // room on both sides of the shipped default rather than only one.
    expect(opensSpeechAt(0.5, ambient, 0.4)).toBe(true);
    expect(opensSpeechAt(0.5, ambient, 0.0005)).toBe(false);
  });
});
