/**
 * §12.5. VAD edges, micro-pause preservation, and dropout handling.
 *
 * The speech boundaries are placed by the test, in milliseconds, before the
 * analyzer ever runs — so the assertions compare the VAD's answer against a
 * number the VAD had no part in choosing. Tolerances are deliberately *tighter*
 * than the hysteresis being exercised (100 ms open, 250 ms close): a
 * ±60 ms assertion cannot be satisfied by an implementation that reports the
 * confirmation instant instead of backdating the run.
 *
 * Frames come from the real {@link FrameFeatureExtractor}, not from
 * hand-written probability values, so a change that stops writing
 * `speechProbability` fails here instead of passing on a fixture.
 */
import { describe, expect, it } from 'vitest';
import { FrameFeatureExtractor } from '../../../../src/shared/coaching/audio/frame-features';
import { SpeechClock, type ClosedSpeechInterval } from '../../../../src/shared/coaching/audio/vad';
import { speechTimeline, type SpeechSegment } from './signals';

const RATE = 48_000;
const FRAME_MS = 20;
const FRAME = (RATE * FRAME_MS) / 1000;
const TAKE = 'take-pass-1';

interface RunResult {
  closed: ClosedSpeechInterval[];
  clock: SpeechClock;
}

function run(options: {
  durationMs: number;
  segments: SpeechSegment[];
  dropoutMs?: [number, number];
  noiseRms?: number;
}): RunResult {
  const signal = speechTimeline({
    sampleRate: RATE,
    durationMs: options.durationMs,
    noiseRms: options.noiseRms ?? 0.002,
    segments: options.segments,
  });
  const extractor = new FrameFeatureExtractor({ sampleRate: RATE, frameMs: FRAME_MS });
  const clock = new SpeechClock({ takePassId: TAKE, frameMs: FRAME_MS });
  const scratch = new Float32Array(FRAME);
  const closed: ClosedSpeechInterval[] = [];
  const frameCount = Math.floor(signal.length / FRAME);

  for (let index = 0; index < frameCount; index += 1) {
    const timeMs = index * FRAME_MS;
    const dropout =
      options.dropoutMs !== undefined &&
      timeMs >= options.dropoutMs[0] &&
      timeMs < options.dropoutMs[1];
    if (dropout) {
      scratch.fill(0);
    } else {
      for (let i = 0; i < FRAME; i += 1) scratch[i] = signal[index * FRAME + i] as number;
    }
    const result = clock.process(extractor.process(scratch, timeMs, dropout));
    if (result) closed.push(result);
  }
  return { closed, clock };
}

describe('SpeechClock edges (§12.5)', () => {
  it('places the interval where the speech actually was', () => {
    const { closed } = run({
      durationMs: 4000,
      segments: [{ startMs: 1000, endMs: 2500, f0Hz: 150, rms: 0.08 }],
    });
    expect(closed).toHaveLength(1);
    const interval = (closed[0] as ClosedSpeechInterval).interval;
    // Backdated to the start of the qualifying run, not to the +100 ms
    // confirmation instant.
    expect(interval.startMs).toBeGreaterThanOrEqual(960);
    expect(interval.startMs).toBeLessThanOrEqual(1060);
    // Ends where the audio ended, with the 250 ms close hangover trimmed off.
    expect(interval.endMs).toBeGreaterThanOrEqual(2440);
    expect(interval.endMs).toBeLessThanOrEqual(2560);
    expect(interval.takePassId).toBe(TAKE);
  });

  it('separates two utterances across a gap longer than the close threshold', () => {
    const { closed } = run({
      durationMs: 5000,
      segments: [
        { startMs: 500, endMs: 1500, rms: 0.08 },
        { startMs: 2500, endMs: 3500, rms: 0.08 },
      ],
    });
    expect(closed).toHaveLength(2);
    expect((closed[0] as ClosedSpeechInterval).interval.endMs).toBeLessThan(1600);
    expect((closed[1] as ClosedSpeechInterval).interval.startMs).toBeGreaterThan(2400);
    expect((closed[1] as ClosedSpeechInterval).interval.startMs).toBeLessThan(2600);
  });

  it('preserves a micro-pause as an internal pause instead of splitting (§12.5)', () => {
    const { closed } = run({
      durationMs: 4000,
      segments: [
        { startMs: 800, endMs: 1600, rms: 0.08 },
        { startMs: 1750, endMs: 2600, rms: 0.08 }, // 150 ms gap, under the 250 ms close
      ],
    });
    expect(closed).toHaveLength(1);
    const interval = (closed[0] as ClosedSpeechInterval).interval;
    expect(interval.startMs).toBeLessThan(880);
    expect(interval.endMs).toBeGreaterThan(2500);
    // The pause is *on the clock*, not deleted from it.
    expect(interval.silenceMs).toBeGreaterThanOrEqual(100);
    expect(interval.silenceMs).toBeLessThanOrEqual(220);
  });

  it('does not open on an isolated click shorter than the open threshold', () => {
    const { closed, clock } = run({
      durationMs: 2000,
      segments: [{ startMs: 900, endMs: 940, rms: 0.2 }], // 40 ms burst
    });
    expect(closed).toHaveLength(0);
    expect(clock.speaking).toBe(false);
  });

  it('counts the backdated opening run frame by frame, not from one frame', () => {
    // Articulation WPM is words / voicedMs, so the ~100 ms of opening run that
    // gets backdated into the interval has to be *measured*. With a fully
    // voiced tone, voicedMs must cover essentially the whole interval — if the
    // opening run were attributed from a single frame, the first 100 ms would
    // be counted wrong in one direction or the other.
    const { closed } = run({
      durationMs: 4000,
      segments: [{ startMs: 1000, endMs: 3000, f0Hz: 140, rms: 0.08 }],
    });
    const interval = (closed[0] as ClosedSpeechInterval).interval;
    const duration = interval.endMs - interval.startMs;
    const unvoiced = duration - interval.voicedMs;
    // At most a couple of frames of the onset/offset ramps are unvoiced.
    expect(unvoiced).toBeGreaterThanOrEqual(0);
    expect(unvoiced).toBeLessThanOrEqual(80);
  });

  it('never reports more accounted time than the interval contains', () => {
    const { closed } = run({
      durationMs: 6000,
      segments: [
        { startMs: 600, endMs: 1500, rms: 0.08 },
        { startMs: 1700, endMs: 2600, rms: 0.08 }, // internal pause
        { startMs: 4000, endMs: 5000, rms: 0.08 },
      ],
    });
    for (const result of closed) {
      const duration = result.interval.endMs - result.interval.startMs;
      expect(
        result.interval.voicedMs + result.interval.silenceMs + result.unmeasuredMs,
      ).toBeLessThanOrEqual(duration + 1);
      expect(result.interval.voicedMs).toBeGreaterThanOrEqual(0);
      expect(result.interval.silenceMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('measures voiced time and SNR consistently with the synthesized signal', () => {
    const { closed } = run({
      durationMs: 4000,
      // -22 dBFS voice over a -54 dBFS room => ~32 dB SNR.
      segments: [{ startMs: 1000, endMs: 3000, f0Hz: 180, rms: 0.08 }],
    });
    const interval = (closed[0] as ClosedSpeechInterval).interval;
    const duration = interval.endMs - interval.startMs;
    expect(duration).toBeGreaterThan(1900);
    expect(interval.voicedMs / duration).toBeGreaterThan(0.85);
    expect(interval.meanSnrDb).toBeGreaterThan(25);
    expect(interval.meanSnrDb).toBeLessThan(40);
    // Rule 2: SNR is a positive difference.
    expect(interval.meanSnrDb).toBeGreaterThan(0);
  });
});

describe('SpeechClock and dropouts (§12.4)', () => {
  it('a 400 ms dropout mid-utterance does NOT split the interval or read as a pause', () => {
    const { closed } = run({
      durationMs: 5000,
      segments: [{ startMs: 800, endMs: 3200, f0Hz: 150, rms: 0.08 }],
      dropoutMs: [1600, 2000], // 400 ms > the 250 ms close threshold
    });
    // A dropout treated as silence would close the interval here and open a
    // second one — which is exactly how a lost buffer becomes a fake pause and
    // corrupts pace.
    expect(closed).toHaveLength(1);
    const result = closed[0] as ClosedSpeechInterval;
    expect(result.interval.startMs).toBeLessThan(900);
    expect(result.interval.endMs).toBeGreaterThan(3100);
    // Reported as unmeasured, not as silence.
    expect(result.unmeasuredMs).toBeGreaterThanOrEqual(380);
    expect(result.unmeasuredMs).toBeLessThanOrEqual(440);
    expect(result.interval.silenceMs).toBeLessThan(60);
    expect(result.dropoutFrames).toBe(20);
  });

  it('keeps unmeasured time out of the voiced total', () => {
    const { closed } = run({
      durationMs: 5000,
      segments: [{ startMs: 800, endMs: 3200, f0Hz: 150, rms: 0.08 }],
      dropoutMs: [1600, 2000],
    });
    const result = closed[0] as ClosedSpeechInterval;
    const duration = result.interval.endMs - result.interval.startMs;
    expect(
      result.interval.voicedMs + result.interval.silenceMs + result.unmeasuredMs,
    ).toBeLessThanOrEqual(duration + 1);
    // The unmeasured stretch is genuinely missing from the voiced total.
    expect(result.interval.voicedMs).toBeLessThan(duration - 300);
  });

  it('a dropout during silence does not fabricate an utterance', () => {
    const { closed, clock } = run({
      durationMs: 3000,
      segments: [],
      dropoutMs: [1000, 1600],
    });
    expect(closed).toHaveLength(0);
    expect(clock.speaking).toBe(false);
  });
});

describe('SpeechClock lifecycle', () => {
  it('flush closes an interval that is still open at take end', () => {
    const { clock, closed } = run({
      durationMs: 3000,
      segments: [{ startMs: 1000, endMs: 3000, rms: 0.08 }], // still speaking at the end
    });
    expect(closed).toHaveLength(0);
    expect(clock.speaking).toBe(true);
    const flushed = clock.flush();
    expect(flushed).not.toBeNull();
    expect((flushed as ClosedSpeechInterval).interval.endMs).toBeGreaterThan(2900);
    expect(clock.flush()).toBeNull();
  });

  it('setTakePass closes the open interval under the OLD pass id (§11.3)', () => {
    const { clock } = run({
      durationMs: 3000,
      segments: [{ startMs: 1000, endMs: 3000, rms: 0.08 }],
    });
    const closed = clock.setTakePass('take-pass-2');
    expect((closed as ClosedSpeechInterval).interval.takePassId).toBe(TAKE);
    expect(clock.currentTakePassId).toBe('take-pass-2');
    expect(clock.speaking).toBe(false);
  });

  it('rejects a non-hysteretic configuration', () => {
    expect(
      () => new SpeechClock({ takePassId: TAKE, openThreshold: 0.4, closeThreshold: 0.4 }),
    ).toThrow(/hysteresis/);
  });
});
