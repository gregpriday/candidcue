/**
 * What the voice pipeline does with the frames Rust sends it.
 *
 * Driven through the real `VoiceSessionPipeline`, not a mock of it. The
 * failure this file exists for has happened twice on this project and looks
 * the same both times: the transport is healthy, frames arrive, and the take
 * reports hearing nothing. Every assertion here is on the *effects* — what
 * was retained, what the UI was told —
 * because those are the only things that distinguish a working take from a
 * connected one.
 *
 * No microphone and no socket: `handleSttFrame` is the pipeline's inbound edge
 * and is driven directly, so this runs in node.
 */
import { describe, expect, it } from 'vitest';
import {
  VoiceSessionPipeline,
  type VoicePipelineDeps,
} from '../../../src/control/services/voice-session';
import type { SttFrame } from '../../../src/control/services/stt/local';
import type { CompiledScript } from '../../../src/shared/contracts';

function compiledStub(): CompiledScript {
  return {
    scriptId: 'script-1',
    sourceHash: 'hash-1',
    blocks: [],
    outline: [],
    spokenTokens: [],
    navigationTargets: [],
    literalCommandRanges: [],
    sentences: [],
    diagnostics: [],
    spokenWordCount: 0,
  } as unknown as CompiledScript;
}

interface Harness {
  pipeline: VoiceSessionPipeline;
  /** Raw recogniser text, as the transcript bar and word count receive it. */
  text: Array<{ text: string; final: boolean }>;
  lines: string[];
  items: Array<{ itemId: string; commitSequence: number; transcript: string }>;
  connection: string[];
  holds: Array<{ held: boolean; reason: string | null }>;
  failures: Array<{ code: string; fatal: boolean }>;
  dropped: number[];
}

function harness(overrides: Partial<VoicePipelineDeps> = {}): Harness {
  const text: Harness['text'] = [];
  const lines: string[] = [];
  const items: Harness['items'] = [];
  const connection: string[] = [];
  const holds: Harness['holds'] = [];
  const failures: Harness['failures'] = [];
  const dropped: number[] = [];

  const pipeline = new VoiceSessionPipeline({
    sessionId: 'session-1',
    sessionGeneration: 1,
    compiled: compiledStub(),
    onTranscriptText: (value, final) => text.push({ text: value, final }),
    onTranscriptLine: (line) => lines.push(line),
    onTranscriptItem: (item) =>
      items.push({
        itemId: item.itemId,
        commitSequence: item.commitSequence,
        transcript: item.transcript,
      }),
    onConnectionState: (state) => connection.push(state),
    onFollowingHold: (held, reason) => holds.push({ held, reason }),
    onSessionFailure: (code, fatal) => failures.push({ code, fatal }),
    onAudioDropped: (frames) => dropped.push(frames),
    now: () => 1_000,
    ...overrides,
  });

  return { pipeline, text, lines, items, connection, holds, failures, dropped };
}

/** One complete utterance, exactly as the Rust supervisor would emit it. */
function utterance(generation: number, itemId: string, ordinal: number, text: string): SttFrame[] {
  return [
    { kind: 'itemStarted', generation, itemId, ordinal, audioStartMs: ordinal * 2_000 },
    { kind: 'partial', generation, itemId, text: text.slice(0, 4) },
    { kind: 'partial', generation, itemId, text: text.slice(0, 9) },
    { kind: 'final', generation, itemId, text, audioEndMs: ordinal * 2_000 + 1_800 },
  ];
}

describe('a take turns provider frames into words the aligner can follow', () => {
  it('surfaces one utterance as revisable text and then as settled text', () => {
    const h = harness();
    for (const frame of utterance(1, '1-0', 0, 'Good morning, everyone.')) {
      h.pipeline.handleSttFrame(frame);
    }

    // Partials arrive as revisable text and the final as settled text. That
    // ordering is what the transcript bar renders, and it is deliberately read
    // straight off the wire so it stays honest when alignment is not.
    expect(h.text.map((entry) => entry.final)).toEqual([false, false, true]);
    expect(h.text.at(-1)?.text).toBe('Good morning, everyone.');
  });

  it('reports a finished line once, for the tail and for retention', () => {
    const h = harness();
    for (const frame of utterance(1, '1-0', 0, 'Good morning, everyone.')) {
      h.pipeline.handleSttFrame(frame);
    }
    expect(h.lines).toEqual(['Good morning, everyone.']);
    expect(h.items).toEqual([
      { itemId: '1-0', commitSequence: 0, transcript: 'Good morning, everyone.' },
    ]);
  });

  it('keeps consecutive utterances as separate retained items', () => {
    const h = harness();
    for (const frame of utterance(1, '1-0', 0, 'First sentence.')) h.pipeline.handleSttFrame(frame);
    for (const frame of utterance(1, '1-1', 1, 'Second sentence.')) h.pipeline.handleSttFrame(frame);

    expect(h.items.map((item) => item.transcript)).toEqual([
      'First sentence.',
      'Second sentence.',
    ]);
    // The commit sequence is the retained row's uniqueness key, so two
    // utterances must not collide on it.
    expect(h.items.map((item) => item.commitSequence)).toEqual([0, 1]);
  });

  it('says nothing for a final that is only whitespace', () => {
    // Inworld will happily return a transcript for silence — a 100 ms silent
    // clip came back as "Yeah." from the sync endpoint during protocol work.
    // An empty or blank one must not become a transcript line the presenter
    // sees, nor a retained row.
    const h = harness();
    h.pipeline.handleSttFrame({
      kind: 'itemStarted',
      generation: 1,
      itemId: '1-0',
      ordinal: 0,
      audioStartMs: 0,
    });
    h.pipeline.handleSttFrame({
      kind: 'final',
      generation: 1,
      itemId: '1-0',
      text: '   ',
      audioEndMs: 400,
    });
    expect(h.lines).toEqual([]);
    expect(h.items).toEqual([]);
  });
});

describe('a take is not polluted by the take before it', () => {
  /*
   * Two generations exist and they are NOT the same number.
   *
   * Rust mints one per socket; the coordinator mints one per take. They
   * diverge as soon as anything opens a stream first — the Preflight
   * microphone test does exactly that, so the first real take runs on
   * transport generation 2 while the session is still generation 1. The
   * aligner drops any update whose `sessionGeneration` does not match the
   * session it was initialised with, so stamping the transport's number would
   * discard every word over a connection reporting perfect health.
   */
  it('accepts a take whose transport generation is not the session number', () => {
    const h = harness();
    for (const frame of utterance(97, '97-0', 0, 'Spoken during this take.')) {
      h.pipeline.handleSttFrame(frame);
    }

    // The words actually landed rather than being silently discarded: the two
    // generations are unrelated counters and were once compared to each other.
    expect(h.lines).toEqual(['Spoken during this take.']);
    expect(h.items.map((item) => item.transcript)).toEqual(['Spoken during this take.']);
  });

  it('applies a duplicated final once, however many times it arrives', () => {
    /*
     * The transcript tail, the retained record and the word count are not
     * idempotent. A provider that repeats a final — or a reconnect that
     * replays one — would otherwise show the line twice and inflate the
     * "words heard" figure past what the presenter said.
     */
    const h = harness();
    const frames = utterance(1, '1-0', 0, 'Said exactly once.');
    for (const frame of frames) h.pipeline.handleSttFrame(frame);
    h.pipeline.handleSttFrame(frames[frames.length - 1]!);

    expect(h.lines).toEqual(['Said exactly once.']);
    expect(h.items).toHaveLength(1);
  });
});

describe('the presenter is told when transcription is not trustworthy', () => {
  it('holds following while the transport is anything but connected', () => {
    const h = harness();
    h.pipeline.handleSttFrame({ kind: 'transport', generation: 1, state: 'connected' });
    h.pipeline.handleSttFrame({ kind: 'transport', generation: 1, state: 'degraded' });
    h.pipeline.handleSttFrame({ kind: 'transport', generation: 1, state: 'connected' });

    expect(h.connection).toEqual(['connected', 'reconnecting', 'connected']);
    expect(h.holds).toEqual([
      { held: true, reason: 'transport_degraded' },
      { held: false, reason: null },
    ]);
  });

  it('does not repeat a connection state it has already reported', () => {
    const h = harness();
    for (let i = 0; i < 3; i += 1) {
      h.pipeline.handleSttFrame({ kind: 'transport', generation: 1, state: 'connected' });
    }
    expect(h.connection).toEqual(['connected']);
  });

  it('calls a bad key offline rather than showing a reconnect that will never come', () => {
    const h = harness();
    h.pipeline.handleSttFrame({
      kind: 'failed',
      generation: 1,
      code: 'STT_MODEL_MISSING',
      message: 'API key does not exist',
      recoverable: false,
    });
    expect(h.connection).toEqual(['offline']);
    expect(h.failures).toEqual([{ code: 'STT_MODEL_MISSING', fatal: true }]);
  });

  it('surfaces dropped audio instead of letting it read as silence', () => {
    const h = harness();
    h.pipeline.handleSttFrame({ kind: 'audioDropped', generation: 1, frames: 14 });
    expect(h.dropped).toEqual([14]);
    // Not transcript text: a gap in the audio is not something anybody said.
    expect(h.text).toEqual([]);
  });
});

describe('teardown', () => {
  it('is idempotent, so a double stop cannot throw out of a shutdown path', async () => {
    const h = harness();
    await expect(h.pipeline.stop()).resolves.toBeUndefined();
    await expect(h.pipeline.stop()).resolves.toBeUndefined();
  });

  it('refuses to start after it has been stopped', async () => {
    const h = harness();
    await h.pipeline.stop();
    await expect(h.pipeline.start()).rejects.toThrow('SESSION_STOPPED');
  });

  it('runs the §29.2 preconditions in order and aborts on the first refusal', async () => {
    const order: string[] = [];
    const h = harness({
      startSequence: {
        flushScriptSave: async () => {
          order.push('flush');
        },
        ensureCompiled: async () => {
          order.push('compile');
          throw new Error('COMPILE_BLOCKED');
        },
        awaitStageAck: async () => {
          order.push('stage');
        },
      },
    });

    await expect(h.pipeline.start()).rejects.toThrow('COMPILE_BLOCKED');
    // The stage step never runs, and — the point of the ordering — nothing
    // billable was opened on a session whose compile was not ready.
    expect(order).toEqual(['flush', 'compile']);
  });
});
