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
import type { CompiledScript, TrackingSnapshot } from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
  publishStageDirective: vi.fn(async () => {}),
  publishListenerState: vi.fn(async () => {}),
  closeStage: vi.fn(async () => {}),
}));

const records = vi.hoisted(() => ({
  appendSessionTranscript: vi.fn(async () => 0),
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
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
vi.mock('../../../src/control/services/smooth-follow-adapter', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/smooth-follow-adapter')>();
  return { ...actual, subscribeStageMotionAcks: () => () => {} };
});

const { clearSession, setStageEmitterForTesting, startLiveSession, startPrompting, stopSession } =
  await import('../../../src/control/stores/session');

/** Enough of a CompiledScript for the store; the driver falls back to the mock. */
function compiledStub(): CompiledScript {
  return {
    sourceHash: 'hash-abc',
    sentences: [
      { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 3, text: 'Hello there.' },
    ],
    navigationTargets: [],
    spokenTokens: [],
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
  emitted.length = 0;
  stage.publishStageSnapshot.mockClear();
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
  vi.useRealTimers();
});

/** Every snapshot the store relayed toward Rust. */
function relayedSnapshots(): TrackingSnapshot[] {
  return stage.publishStageSnapshot.mock.calls.map(
    (call) => (call as unknown as [string, TrackingSnapshot])[1],
  );
}

describe('C1 — the session generation control publishes is the one Rust assigned', () => {
  it('stamps the Rust-assigned generation on every relayed snapshot', () => {
    start({ sessionGeneration: 7 });
    startPrompting();
    vi.advanceTimersByTime(1600 * 3);

    const snapshots = relayedSnapshots();
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      // The hard-coded 1 is what `validate_stage_payload_header` compared
      // against a coordinator sitting at 0, and dropped.
      expect(snapshot.sessionGeneration).toBe(7);
      expect(snapshot.sessionGeneration).not.toBe(1);
    }
  });

  it('adopts a different generation for the next take rather than reusing one', () => {
    start({ sessionGeneration: 7 });
    startPrompting();
    vi.advanceTimersByTime(1600 * 2);
    stopSession();
    clearSession();
    stage.publishStageSnapshot.mockClear();

    start({ sessionGeneration: 8 });
    startPrompting();
    vi.advanceTimersByTime(1600 * 2);

    const snapshots = relayedSnapshots();
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.every((s) => s.sessionGeneration === 8)).toBe(true);
  });
});

describe('C2 — stage://semantic-frame has a producer', () => {
  it('emits a semantic motion frame to the stage window as the session moves', () => {
    start();
    startPrompting();
    vi.advanceTimersByTime(1600 * 3);

    const frames = emitted.filter((e) => e.event === STAGE_EVENT.semanticFrame);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?.target).toBe('stage');

    const frame = frames[0]?.payload as { sessionGeneration: number; estimatedUnit: number };
    // The frame carries the same session generation as the snapshots, so the
    // stage's frame receiver can gate on it.
    expect(frame.sessionGeneration).toBe(7);
    expect(typeof frame.estimatedUnit).toBe('number');
  });

  it('stops producing frames once the session is over', () => {
    start();
    startPrompting();
    vi.advanceTimersByTime(1600 * 2);
    expect(emitted.some((e) => e.event === STAGE_EVENT.semanticFrame)).toBe(true);

    stopSession();
    emitted.length = 0;
    vi.advanceTimersByTime(1600 * 4);
    expect(emitted.filter((e) => e.event === STAGE_EVENT.semanticFrame)).toHaveLength(0);
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
      onMaskItems: (ids: string[]) => void;
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
    // The command channel consumed the second phrase (§33.4).
    deps.onMaskItems(['item_a2']);
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
    // A phrase the command channel consumed is a command, not performed script.
    expect(items[1]).toMatchObject({ commitSequence: 2, disposition: 'command' });
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
