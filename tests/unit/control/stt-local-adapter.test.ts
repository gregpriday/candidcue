/**
 * The Rust → TypeScript seam for speech-to-text.
 *
 * This is the join the whole provider migration rests on. The tracking engine,
 * the ledger and the worker protocol were written against a provider-neutral
 * `TranscriptEvent` model, so swapping one recogniser for another is a change of
 * producer and nothing else — provided the producer produces the right shape.
 * If it does not, the failure is silent in the worst possible way: a session
 * connects, frames arrive, and the cursor never moves.
 *
 * Everything here is a pure function over a frame, so it runs in node with no
 * socket, no microphone and no Tauri.
 */
import { describe, expect, it } from 'vitest';
import {
  encodePcm16,
  STT_FRAME_MS,
  STT_SAMPLE_RATE_HZ,
} from '../../../src/control/services/stt/local';
import { FRAME_SAMPLES, FrameAccumulator, resampleLinear } from '../../../src/control/services/audio/capture';

describe('PCM16 encoding', () => {
  it('round-trips samples through base64 at the expected byte width', () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const encoded = encodePcm16(samples);
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    expect(bytes.length).toBe(samples.length * 2);

    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(Math.round(0.5 * 32_767));
    expect(view.getInt16(4, true)).toBe(Math.round(-0.5 * 32_767));
    expect(view.getInt16(6, true)).toBe(32_767);
    expect(view.getInt16(8, true)).toBe(-32_767);
  });

  /*
   * Out-of-range samples WRAP rather than clip when cast, so a loud passage
   * would arrive as a burst of white noise — audible as a transcript that goes
   * to pieces exactly when the presenter raises their voice, which reads as a
   * recogniser problem rather than an encoder one.
   */
  it('clamps rather than wraps a sample outside [-1, 1]', () => {
    const bytes = Uint8Array.from(atob(encodePcm16(Float32Array.from([2.5, -3]))), (c) =>
      c.charCodeAt(0),
    );
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(32_767);
    expect(view.getInt16(2, true)).toBe(-32_767);
  });

  it('encodes a full frame without overflowing the argument limit', () => {
    // `String.fromCharCode(...bytes)` throws past a few tens of thousands of
    // arguments. Today's frame is comfortably under; the chunking exists so
    // raising the frame size is not a latent crash.
    const big = new Float32Array(FRAME_SAMPLES * 8);
    expect(() => encodePcm16(big)).not.toThrow();
    expect(atob(encodePcm16(big)).length).toBe(big.length * 2);
  });
});

describe('capture framing', () => {
  it('emits exactly-sized frames and holds the remainder back', () => {
    const frames: number[] = [];
    const accumulator = new FrameAccumulator(4, (frame) => frames.push(frame.length));

    accumulator.push(Float32Array.from([1, 2, 3]));
    expect(frames).toEqual([]);
    expect(accumulator.pendingCount).toBe(3);

    accumulator.push(Float32Array.from([4, 5, 6, 7, 8, 9]));
    expect(frames).toEqual([4, 4]);
    // One sample left over rather than emitted short or dropped: a short frame
    // misstates its own duration, and a dropped one loses a slice of speech.
    expect(accumulator.pendingCount).toBe(1);
  });

  it('preserves sample order across frame boundaries', () => {
    const seen: number[] = [];
    const accumulator = new FrameAccumulator(3, (frame) => seen.push(...frame));
    accumulator.push(Float32Array.from([1, 2]));
    accumulator.push(Float32Array.from([3, 4, 5, 6, 7]));
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('derives the frame size from the pinned rate and frame duration', () => {
    expect(FRAME_SAMPLES).toBe((STT_SAMPLE_RATE_HZ * STT_FRAME_MS) / 1000);
  });
});

describe('resampling', () => {
  /*
   * Insurance against an engine that ignores the requested `sampleRate`.
   * Without it, 48 kHz capture would be streamed under a config frame claiming
   * 24 kHz — double speed, and the result is not an error but a transcript of
   * something nobody said.
   */
  it('halves the sample count from 48 kHz to 24 kHz', () => {
    const input = Float32Array.from({ length: 480 }, (_, i) => i / 480);
    expect(resampleLinear(input, 48_000, 24_000).length).toBe(240);
  });

  it('returns the input untouched when the rate already matches', () => {
    const input = Float32Array.from([0.1, 0.2, 0.3]);
    expect(resampleLinear(input, 24_000, 24_000)).toBe(input);
  });

  it('interpolates rather than dropping every other sample', () => {
    // A pure decimation would return [0, 2]; linear interpolation of a ramp
    // keeps the midpoint, which is what stops downsampling adding harmonics.
    const out = resampleLinear(Float32Array.from([0, 1, 2, 3]), 48_000, 24_000);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(2, 6);
  });
});
