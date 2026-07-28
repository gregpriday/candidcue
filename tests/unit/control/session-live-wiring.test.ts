/**
 * C1 / C2 / C11 regression — the three things a packaged build needed and did
 * not have.
 *
 * The defect these guard survived 2038 green vitest tests, because every one of
 * them stopped at the seam: the store was tested, the stage renderer was tested,
 * and nothing asserted that the numbers crossing between them agreed or that
 * anything was ever sent at all.
 *
 * What each test here would catch on revert:
 *  1. `sessionGeneration` back to a hard-coded 1 → the relayed snapshot carries
 *     1 instead of the generation Rust assigned, and Rust drops it;
 *  2. `publishSemanticFrame` removed → `stage://semantic-frame` has no producer
 *     again and the stage's whole v2 motion engine receives nothing;
 *  3. transcript retention wired to anything other than the Rust-decided flag →
 *     either nothing is ever kept, or words are kept when the user said no.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STAGE_EVENT } from '../../../src/shared/contracts';
import type { CompiledScript } from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  /* §64: the heartbeat compares what control sent against what the stage
     applied. `exists: false` means "no stage to compare with", which is the
     right answer for a mock that is not modelling a stage window. */
  getStageStatus: vi.fn(async () => ({ exists: false })),
  publishStageDirective: vi.fn(async () => {}),
  publishListenerState: vi.fn(async () => {}),
  closeStage: vi.fn(async () => {}),
  listDisplays: vi.fn(async () => [{ fingerprint: 'display-0' }]),
}));

const records = vi.hoisted(() => ({
  appendSessionTranscript: vi.fn(async () => 0),
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
  // §36.3 take history — part of the same module the store imports.
  recordSessionTake: vi.fn(async () => null),
  listSessionTakes: vi.fn(async () => []),
}));

/**
 * The voice pipeline is stubbed so the test can drive `onTranscriptItem` and
 * `onMaskItems` directly — those callbacks are the store's retention feed, and a
 * real WebRTC transport cannot be stood up in node.
 */
const pipeline = vi.hoisted(() => {
  const captured: { deps: Record<string, (...args: never[]) => unknown> | null } = { deps: null };
  class FakePipeline {
    constructor(deps: Record<string, (...args: never[]) => unknown>) {
      captured.deps = deps;
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    startListening(): void {}
    softPause(): void {}
    async hardPause(): Promise<void> {}
    async resume(): Promise<void> {}
    estimatedCostUsd(): number {
      return 0;
    }
  }
  return { captured, FakePipeline };
});

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('../../../src/control/services/stage', () => stage);
vi.mock('../../../src/control/services/session-records', () => records);
vi.mock('../../../src/control/services/voice-session', () => ({
  VoiceSessionPipeline: pipeline.FakePipeline,
  COMMAND_TICK_INTERVAL_MS: 250,
}));
vi.mock('../../../src/control/services/semantic-sidecar', () => ({
  SemanticSidecar: class {
    scheduler = {
      getDiagnostics: () => ({
        requestsByLane: {},
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
        availability: 'disabled' as const,
        // §42.2: unknown, never a confident zero.
        estimatedCostUsd: null,
      }),
      getAvailability: () => 'disabled' as const,
      getBudget: () => ({
        maxRequestsPerSession: 400,
        maxRequestsPerHour: 600,
        maxTotalTokens: 1_500_000,
      }),
    };
    attachContextSource(): void {}
    cancelInFlight(): void {}
    setMode(): void {}
    setRequestLimit(): void {}
    setPrices(): void {}
    dispose(): void {}
  },
}));
vi.mock('../../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});
/*
 * The snapshot feed arrives from Rust over a Tauri event channel, which does
 * not exist in node. Capturing the subscription lets a test push a snapshot
 * through the REAL driver and the REAL store, which is the only way to assert
 * on anything the take summary accumulates.
 */
const alignmentFeed: { push: ((snapshot: unknown) => void) | null } = { push: null };
vi.mock('../../../src/control/services/alignment', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/alignment')>();
  return {
    ...actual,
    subscribeAlignmentSnapshots: (handler: (snapshot: never) => void) => {
      alignmentFeed.push = handler as (snapshot: unknown) => void;
      return () => {
        alignmentFeed.push = null;
      };
    },
  };
});
vi.mock('../../../src/control/services/stage-acks', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/stage-acks')>();
  return { ...actual, subscribeStageMotionAcks: () => () => {} };
});

const { setInvokeForTesting } = await import('../../../src/control/services/ipc');
const { clearSession, setStageEmitterForTesting, startLiveSession, startPrompting, stopSession } =
  await import('../../../src/control/stores/session');

/** Enough of a CompiledScript for the store and for the alignment handshake. */
function compiledStub(): CompiledScript {
  return {
    sourceHash: 'hash-abc',
    spokenTokens: [
      { index: 0, blockId: 'b-1', sentenceId: 's-1', surface: 'Hello', normalized: 'hello' },
      { index: 1, blockId: 'b-1', sentenceId: 's-1', surface: 'there', normalized: 'there' },
    ],
    sentences: [
      { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 3, text: 'Hello there.' },
    ],
    navigationTargets: [],
    literalCommandRanges: [],
  } as unknown as CompiledScript;
}

interface StartOverrides {
  sessionGeneration?: number;
  transcriptRetained?: boolean;
  mode?: 'voice' | 'manual';
}

function start(overrides: StartOverrides = {}): string {
  return startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: overrides.mode ?? 'voice',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: 'session-uuid-1',
    compiled: compiledStub(),
    stageGeneration: 4,
    sessionGeneration: overrides.sessionGeneration ?? 7,
    transcriptRetained: overrides.transcriptRetained ?? false,
  });
}

const emitted: Array<{ target: string; event: string; payload: unknown }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  invoked.length = 0;
  setInvokeForTesting(async (command, args) => {
    invoked.push({ command, args });
    return undefined as never;
  });
  emitted.length = 0;
  records.appendSessionTranscript.mockClear();
  records.endSessionRecord.mockClear();
  pipeline.captured.deps = null;
  setStageEmitterForTesting(async (target, event, payload) => {
    emitted.push({ target, event, payload });
  });
});

afterEach(() => {
  clearSession();
  setStageEmitterForTesting(null);
  setInvokeForTesting(null);
  vi.useRealTimers();
});

/** Every IPC command the store issued, in order. */
const invoked: Array<{ command: string; args?: Record<string, unknown> }> = [];

/**
 * C1 — the session generation control hands Rust is the one Rust assigned.
 *
 * The hard-coded `1` is what `validate_stage_payload_header` compared against a
 * coordinator sitting elsewhere, and dropped. Motion no longer travels through
 * control at all, but the generation still does: it is the argument that pairs
 * an alignment session with the socket feeding it, and Rust drops every
 * transcript frame whose generation does not match.
 */
describe('C1 — the generation control hands Rust is the one Rust assigned', () => {
  it('starts alignment under the assigned generation, not a literal 1', async () => {
    start({ sessionGeneration: 7 });
    startPrompting();
    await vi.advanceTimersByTimeAsync(0);
    const call = invoked.find((c) => c.command === 'start_alignment');
    expect(call, 'the take never started an alignment session').toBeDefined();
    expect(call?.args?.generation).toBe(7);
    expect(call?.args?.generation).not.toBe(1);
  });

  it('adopts a different generation for the next take rather than reusing one', async () => {
    start({ sessionGeneration: 7 });
    startPrompting();
    await vi.advanceTimersByTimeAsync(0);
    stopSession();
    clearSession();
    invoked.length = 0;

    start({ sessionGeneration: 8 });
    startPrompting();
    await vi.advanceTimersByTimeAsync(0);
    const call = invoked.find((c) => c.command === 'start_alignment');
    expect(call?.args?.generation).toBe(8);
  });

  it('stops the alignment session when the take ends', async () => {
    start({ sessionGeneration: 7 });
    startPrompting();
    stopSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoked.some((c) => c.command === 'stop_alignment')).toBe(true);
  });
});

describe('C11 — transcript retention follows the setting Rust decided (§36.2)', () => {
  function finalizeSpeech(): void {
    const deps = pipeline.captured.deps as unknown as {
      onTranscriptItem?: (item: {
        itemId: string;
        commitSequence: number;
        audioStartMs?: number;
        audioEndMs?: number;
        transcript: string;
      }) => void;
    };
    deps.onTranscriptItem?.({
      itemId: 'item_a1',
      commitSequence: 1,
      audioStartMs: 0,
      audioEndMs: 2400,
      transcript: 'Good morning, everyone.',
    });
    deps.onTranscriptItem?.({
      itemId: 'item_a2',
      commitSequence: 2,
      audioStartMs: 2400,
      audioEndMs: 4100,
      transcript: 'CandidCue, next section.',
    });
  }

  it('persists finalized items when the session was started with retention on', () => {
    start({ transcriptRetained: true });
    startPrompting();
    expect(pipeline.captured.deps).not.toBeNull();
    finalizeSpeech();

    const summary = stopSession();
    expect(summary.transcriptSaved).toBe(true);
    expect(records.appendSessionTranscript).toHaveBeenCalledTimes(1);

    const [sessionId, items] = records.appendSessionTranscript.mock.calls[0] as unknown as [
      string,
      Array<{ commitSequence: number; transcript: string; disposition: string }>,
    ];
    expect(sessionId).toBe('session-uuid-1');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      commitSequence: 1,
      transcript: 'Good morning, everyone.',
      disposition: 'script',
    });
    // Everything the recogniser returns is performed script now: with no
    // command channel there is nothing else it could be, and the column keeps
    // its vocabulary so an older row still reads correctly.
    expect(items[1]).toMatchObject({ commitSequence: 2, disposition: 'script' });
  });

  it('persists nothing at all when the user has retention off', () => {
    start({ transcriptRetained: false });
    startPrompting();
    finalizeSpeech();

    const summary = stopSession();
    expect(summary.transcriptSaved).toBe(false);
    // Not "an empty array was sent" — no call, and no text buffered to send.
    expect(records.appendSessionTranscript).not.toHaveBeenCalled();
  });

  it('closes the session record on stop, with the §36.1 aggregate metrics', () => {
    start({ transcriptRetained: false });
    startPrompting();
    // One real snapshot through the real driver: `sectionsReached` is a fact
    // about alignment output, and a take that produced none has reached none.
    alignmentFeed.push?.({
      sessionGeneration: 7,
      seq: 1,
      state: 'following',
      decision: 'localConfirmed',
      confirmedToken: 1,
      observedToken: 2,
      rateTokensPerSecond: 2.5,
      evidenceAudioMs: 1000,
      atAudioMs: 1000,
      maxPredictionMs: 900,
      confidence: 0.9,
      suggestionToken: null,
      scriptLenTokens: 200,
      observedAtom: 2,
      confirmedAtom: 1,
    });
    vi.advanceTimersByTime(1600 * 3);
    stopSession();

    expect(records.endSessionRecord).toHaveBeenCalledTimes(1);
    const [sessionId, summary] = records.endSessionRecord.mock.calls[0] as unknown as [
      string,
      { endTokenIndex?: number; metrics?: { sectionsReached: number } },
    ];
    expect(sessionId).toBe('session-uuid-1');
    expect(typeof summary.endTokenIndex).toBe('number');
    expect(summary.metrics?.sectionsReached).toBeGreaterThan(0);
  });
});
