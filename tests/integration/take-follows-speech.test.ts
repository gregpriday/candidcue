/**
 * Does a take actually follow? The one question no test in this repo asks.
 *
 * There is thorough coverage of the aligner given transcript events, and
 * thorough coverage of the pipeline given provider frames — and nothing that
 * joins the two. So a build could ship in which every unit test passed, the
 * provider returned 28 words, and the cursor never moved once. It did ship,
 * twice.
 *
 * This drives the REAL `VoiceSessionPipeline` with the REAL frame sequence
 * captured from a failing take, wires it to a REAL `AlignmentEngine` through
 * the same callbacks the session store uses — including the transport-hold
 * path, because that is the part under suspicion — and asserts that words in
 * produce cursor movement out.
 *
 * No microphone, no socket, no Tauri. If this goes red, the app is broken; if
 * it goes green while the app is broken, the harness is lying and that is the
 * first thing to fix.
 */
import { describe, expect, it } from 'vitest';
import { AlignmentEngine } from '../../src/shared/tracking/engine';
import type { TranscriptEvent } from '../../src/shared/tracking/types';
import {
  VoiceSessionPipeline,
  type VoicePipelineDeps,
} from '../../src/control/services/voice-session';
import type { SttFrame } from '../../src/control/services/stt/inworld';
import { demoDocument } from '../fixtures/alignment/fixture-script';
import type { CompiledScript } from '../../src/shared/contracts';

const SESSION_GENERATION = 1;
/** The transport generation Rust minted. Deliberately not the session's. */
const TRANSPORT_GENERATION = 1;

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

/**
 * The pipeline and the engine, wired exactly as `stores/session.ts` wires them.
 *
 * `onFollowingHold` is the wiring under suspicion: the store turns it into
 * `driver.pause()` / `driver.resume()`, which reach `engine.pause()` /
 * `engine.resume()`, and a paused engine discards every transcript event
 * before matching. Reproducing that faithfully is the whole point — a harness
 * that omitted it would pass while the app failed.
 */
function harness(options: { honourFollowingHold: boolean }) {
  const engine = new AlignmentEngine(demoDocument(), {
    sessionId: 'session-1',
    sessionGeneration: SESSION_GENERATION,
    stageGeneration: 1,
    layoutGeneration: 1,
  });
  let now = 10_000;
  const holds: Array<{ held: boolean; reason: string | null }> = [];

  const deps: VoicePipelineDeps = {
    sessionId: 'session-1',
    sessionGeneration: SESSION_GENERATION,
    compiled: compiledStub(),
    onTrackingEvent: (event: TranscriptEvent) => {
      engine.handleTranscriptEvent(event);
    },
    onTranscriptLine: () => {},
    onConnectionState: () => {},
    onFollowingHold: (held, reason) => {
      holds.push({ held, reason });
      if (!options.honourFollowingHold) return;
      // Exactly what the session store does with this callback.
      if (held) engine.pause(now);
      else engine.resume(now);
    },
    now: () => now,
  };

  const pipeline = new VoiceSessionPipeline(deps);
  return {
    engine,
    pipeline,
    holds,
    advance(ms: number) {
      now += ms;
    },
  };
}

/**
 * The frames from a real 12-second take, in the order and at the offsets the
 * trace recorded. The words are the opening of the fixture script so the
 * aligner has something真 to match; the SHAPE is what came off the wire.
 */
function capturedTake(): Array<{ atMs: number; frame: SttFrame }> {
  const g = TRANSPORT_GENERATION;
  return [
    { atMs: 68, frame: { kind: 'transport', generation: g, state: 'connecting' } },
    { atMs: 558, frame: { kind: 'transport', generation: g, state: 'connected' } },
    {
      atMs: 2244,
      frame: { kind: 'itemStarted', generation: g, itemId: '1-0', ordinal: 0, audioStartMs: 2000 },
    },
    { atMs: 3049, frame: { kind: 'partial', generation: g, itemId: '1-0', text: 'Hello everyone' } },
    {
      atMs: 4071,
      frame: { kind: 'partial', generation: g, itemId: '1-0', text: 'Hello everyone and welcome' },
    },
    {
      atMs: 4326,
      frame: {
        kind: 'final',
        generation: g,
        itemId: '1-0',
        text: 'Hello everyone and welcome to the channel.',
        audioEndMs: 4200,
      },
    },
    {
      atMs: 4547,
      frame: { kind: 'itemStarted', generation: g, itemId: '1-1', ordinal: 1, audioStartMs: 4400 },
    },
    {
      atMs: 5271,
      frame: { kind: 'partial', generation: g, itemId: '1-1', text: 'Today we are' },
    },
    {
      atMs: 8501,
      frame: {
        kind: 'final',
        generation: g,
        itemId: '1-1',
        text: 'Today we are talking about building a teleprompter that actually listens.',
        audioEndMs: 8400,
      },
    },
  ];
}

function play(h: ReturnType<typeof harness>): void {
  let last = 0;
  for (const { atMs, frame } of capturedTake()) {
    h.advance(atMs - last);
    last = atMs;
    h.pipeline.handleSttFrame(frame);
  }
}

describe('a take that hears words follows them', () => {
  /*
   * The control: with the transport hold disconnected, does the engine follow
   * this exact evidence at all? If this fails, the problem is the aligner and
   * no amount of lifecycle work will help.
   */
  it('the aligner commits from this evidence when nothing pauses it', () => {
    const h = harness({ honourFollowingHold: false });
    play(h);

    expect(
      h.engine.cursor.committedTokenIndex,
      'the aligner did not move on evidence it should match verbatim',
    ).toBeGreaterThan(0);
  });

  /*
   * The real wiring. `rx:transport connecting` arrives BEFORE the first audio
   * frame on every take, and the store turns any non-connected transport state
   * into `driver.pause()`. A paused engine returns `{}` from
   * `handleTranscriptEvent` before it looks at a single token.
   */
  it('follows through the connecting → connected transport sequence', () => {
    const h = harness({ honourFollowingHold: true });
    play(h);

    // No hold at all on the way in: `connecting` before the first `connected`
    // is a session opening, not a session in trouble.
    expect(h.holds).toEqual([]);
    expect(
      h.engine.cursor.committedTokenIndex,
      'the take heard every word and followed none of them — the failure this ' +
        'file exists to catch',
    ).toBeGreaterThan(0);
  });

  /*
   * The narrow version of the same defect, isolated. `connecting` is not a
   * degraded state that deserves a following hold: it is the FIRST thing every
   * healthy session emits, before any audio has been sent. Holding on it means
   * every take begins paused.
   */
  it('does not hold following merely because the session is opening', () => {
    const h = harness({ honourFollowingHold: true });
    h.pipeline.handleSttFrame({
      kind: 'transport',
      generation: TRANSPORT_GENERATION,
      state: 'connecting',
    });
    expect(
      h.holds.filter((hold) => hold.held),
      'a session that is merely opening must not pause the aligner',
    ).toEqual([]);
  });
});

describe('a reconnect mid-take is still a hold', () => {
  /*
   * The other half of the same rule, and the reason it is a rule rather than
   * "never hold on connecting". Once a session HAS connected, a return to
   * `connecting` means the transport dropped — and following through that is
   * the stage drifting on a stale pace estimate while the presenter keeps
   * talking to a script that is no longer tracking them.
   */
  it('holds when the transport drops after connecting, and releases on recovery', () => {
    const h = harness({ honourFollowingHold: true });
    const g = TRANSPORT_GENERATION;

    h.pipeline.handleSttFrame({ kind: 'transport', generation: g, state: 'connecting' });
    h.pipeline.handleSttFrame({ kind: 'transport', generation: g, state: 'connected' });
    expect(h.holds, 'opening must not hold').toEqual([]);

    h.pipeline.handleSttFrame({ kind: 'transport', generation: g, state: 'connecting' });
    h.pipeline.handleSttFrame({ kind: 'transport', generation: g, state: 'connected' });
    expect(h.holds).toEqual([
      { held: true, reason: 'transport_connecting' },
      { held: false, reason: null },
    ]);
  });

  it('holds on a degraded transport even before the first connect', () => {
    // `degraded` is never routine — it means a connect attempt failed and the
    // supervisor is backing off. That is worth holding for at any point.
    const h = harness({ honourFollowingHold: true });
    h.pipeline.handleSttFrame({
      kind: 'transport',
      generation: TRANSPORT_GENERATION,
      state: 'degraded',
    });
    expect(h.holds).toEqual([{ held: true, reason: 'transport_degraded' }]);
  });
});
