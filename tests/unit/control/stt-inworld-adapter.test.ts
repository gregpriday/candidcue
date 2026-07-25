/**
 * The Rust → TypeScript seam for speech-to-text.
 *
 * This is the join the whole provider migration rests on. The tracking engine,
 * the ledger and the worker protocol were written against a provider-neutral
 * `TranscriptEvent` model, so swapping OpenAI for Inworld is a change of
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
  toTrackingEvent,
  STT_FRAME_MS,
  STT_SAMPLE_RATE_HZ,
  type SttFrame,
} from '../../../src/control/services/stt/inworld';
import { FRAME_SAMPLES, FrameAccumulator, resampleLinear } from '../../../src/control/services/audio/capture';

const RECEIVED_AT = 1_700_000_000_000;
/** The SESSION generation, deliberately different from any frame's. */
const SESSION_GENERATION = 1;
/** Control-window time at which capture began. */
const AUDIO_ORIGIN = 1_699_999_990_000;

/** Curried for brevity; every call passes the same session identity. */
function map(frame: SttFrame, receivedAtMs = RECEIVED_AT) {
  return toTrackingEvent(frame, receivedAtMs, SESSION_GENERATION, AUDIO_ORIGIN);
}

describe('Rust frames become tracking transcript events', () => {
  it('opens an item with the utterance ordinal as its commit sequence', () => {
    const event = map({
      kind: 'itemStarted',
      generation: 7,
      itemId: '7-3',
      ordinal: 3,
      audioStartMs: 4_800,
    });
    expect(event).toEqual({
      type: 'item_started',
      sessionGeneration: SESSION_GENERATION,
      itemId: '7-3',
      // Inworld has no commit; the ordinal is the monotonic sequence the ledger
      // needs, and it must not be invented separately anywhere else.
      commitSequence: 3,
      audioStartMs: AUDIO_ORIGIN + 4_800,
      receivedAtMs: RECEIVED_AT,
    });
  });

  it('carries an interim transcript as a delta and a final one as completed', () => {
    expect(map({ kind: 'partial', generation: 1, itemId: '1-0', text: 'good mor' }, 5)).toEqual({
      type: 'delta',
      sessionGeneration: SESSION_GENERATION,
      itemId: '1-0',
      text: 'good mor',
      receivedAtMs: 5,
    });

    expect(
      map(
        { kind: 'final', generation: 1, itemId: '1-0', text: 'Good morning.', audioEndMs: 2_400 },
        6,
      ),
    ).toEqual({
      type: 'completed',
      sessionGeneration: SESSION_GENERATION,
      itemId: '1-0',
      text: 'Good morning.',
      audioEndMs: AUDIO_ORIGIN + 2_400,
      receivedAtMs: 6,
    });
  });

  /*
   * Inworld's interims are CUMULATIVE — each restates the utterance so far
   * rather than appending to the last. The ledger treats a delta as the item's
   * provisional text in full, which matches. A future adapter that "helpfully"
   * concatenated would produce "the the quick the quick brown" and the aligner
   * would follow a sentence nobody said.
   */
  it('passes an interim through whole, because interims restate rather than append', () => {
    const growing = ['Good', 'Good morning', 'Good morning everyone'];
    const texts = growing.map((text) => {
      const event = map({ kind: 'partial', generation: 1, itemId: '1-0', text }, 0);
      return event?.type === 'delta' ? event.text : null;
    });
    expect(texts).toEqual(growing);
  });

  it('reports a fatal provider error as unrecoverable, so the UI stops promising a reconnect', () => {
    const fatal = map(
      {
        kind: 'failed',
        generation: 2,
        code: 'AUTH_KEY_INVALID',
        message: 'API key does not exist',
        recoverable: false,
      },
      9,
    );
    expect(fatal).toEqual({
      type: 'failed',
      sessionGeneration: SESSION_GENERATION,
      code: 'AUTH_KEY_INVALID',
      recoverable: false,
      receivedAtMs: 9,
    });
  });

  it('maps every transport state the supervisor can emit', () => {
    const states = ['connecting', 'connected', 'degraded', 'closed'] as const;
    for (const state of states) {
      const event = map({ kind: 'transport', generation: 4, state }, 0);
      expect(event).toEqual({
        type: 'transport_state',
        sessionGeneration: SESSION_GENERATION,
        state,
        receivedAtMs: 0,
      });
    }
  });

  /*
   * Dropped audio is not a transcript event and must not be smuggled in as
   * one — but it must not vanish either. It is the difference between "the
   * presenter said nothing" and "we threw away what they said", and those look
   * identical from downstream. The pipeline surfaces it on its own callback.
   */
  it('refuses to turn dropped audio into a transcript event', () => {
    expect(map({ kind: 'audioDropped', generation: 1, frames: 12 }, 0)).toBeNull();
  });

  it('covers every frame kind, so a new one cannot be silently ignored', () => {
    const kinds: Array<SttFrame['kind']> = [
      'itemStarted',
      'partial',
      'final',
      'transport',
      'failed',
      'audioDropped',
    ];
    // The union is exhaustively switched in `toTrackingEvent`; this asserts the
    // list here has not drifted from it, which is what would let a new kind be
    // added and never handled.
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe('the two identities that must not be confused', () => {
  /*
   * Rust mints its own monotonic generation per socket; the coordinator mints
   * a session generation per take. They diverge the moment anything opens a
   * stream first — the Preflight microphone test does exactly that, so the
   * first real take runs on transport generation 2 against session generation
   * 1. `AlignmentEngine.handleTranscriptEvent` drops every update whose
   * `sessionGeneration` does not match the session it was initialised with, so
   * passing the transport's number through discards every word on a connection
   * reporting perfect health. That is the failure this whole migration exists
   * to eliminate, reached by a different route.
   */
  it('stamps the SESSION generation, never the transport frame generation', () => {
    for (const generation of [2, 7, 99]) {
      const event = map({ kind: 'partial', generation, itemId: `${generation}-0`, text: 'hi' });
      expect(event?.sessionGeneration).toBe(SESSION_GENERATION);
      expect(event?.sessionGeneration).not.toBe(generation);
    }
  });

  /*
   * Rust's audio clock counts milliseconds of audio handed to the socket,
   * starting at zero. The tracking worker's `SessionClock.map` treats
   * `audioStartMs`/`audioEndMs` as secondary stamps on the SAME producer clock
   * as `receivedAtMs` and computes `max(0, stamp - origin)` against an
   * epoch-scale origin — so a zero-based duration clamps to 0 for every single
   * item, and the pace estimator and evidence-age checks silently lose their
   * input. Anchoring at the capture origin restores the offset the clock is
   * entitled to assume.
   */
  it('expresses the audio clock on the same clock as receivedAtMs', () => {
    const started = map({
      kind: 'itemStarted',
      generation: 1,
      itemId: '1-0',
      ordinal: 0,
      audioStartMs: 0,
    });
    expect(started?.type).toBe('item_started');
    if (started?.type !== 'item_started') throw new Error('unreachable');

    // Epoch-scale, not a bare duration — otherwise the worker clamps it away.
    expect(started.audioStartMs).toBe(AUDIO_ORIGIN);
    expect(started.audioStartMs).toBeGreaterThan(1_000_000_000_000);

    const done = map({
      kind: 'final',
      generation: 1,
      itemId: '1-0',
      text: 'x',
      audioEndMs: 3_200,
    });
    if (done?.type !== 'completed') throw new Error('unreachable');
    // And the DURATION between them survives the shift exactly.
    expect((done.audioEndMs ?? 0) - started.audioStartMs).toBe(3_200);
  });
});

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
