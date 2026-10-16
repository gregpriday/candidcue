/**
 * §36.3 take history — the control side.
 *
 * Before this, `retake_count` was the whole of what a take left behind. The
 * session store already accumulated the block ids it passed through and read
 * them only as a count; `addTakeMarker` — the handler for the "mark this" voice
 * command — incremented a counter and stored no marker at all.
 *
 * The two assertions that matter:
 *
 *  - a take's history round-trips: times, sections traversed and checkpoints all
 *    reach `record_session_take`;
 *  - a second take does not overwrite the first — a retake closes the pass that
 *    was running and opens the next ordinal, so both are written.
 *
 * On revert nothing calls `recordSessionTake` at all and every test here fails
 * on the first assertion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompiledScript, AlignmentSnapshot } from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
  listDisplays: vi.fn(async () => [{ fingerprint: 'display-0' }]),
}));

const records = vi.hoisted(() => ({
  appendSessionTranscript: vi.fn(async () => 0),
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
  recordSessionTake: vi.fn(async () => null),
  listSessionTakes: vi.fn(async () => []),
}));

/**
 * The tracking driver is faked so the test can push snapshots directly — the
 * sections a take traversed come from the snapshot feed, and the mock driver's
 * animation would make the assertion time-dependent.
 */
const driver = vi.hoisted(() => {
  const captured: { onSnapshot: ((s: unknown) => void) | null } = { onSnapshot: null };
  return {
    captured,
    createTrackingDriver: vi.fn((deps: { onSnapshot: (s: unknown) => void }) => {
      captured.onSnapshot = deps.onSnapshot;
      return {
        // Starting a take now starts prompting, so the fake needs the whole
        // `TrackingDriver` surface rather than the half this file happened to
        // exercise. A fake that is missing a method the store calls fails as
        // `driver?.start is not a function`, which reads like a store bug.
        start: vi.fn(),
        feedTranscript: vi.fn(),
        maskItems: vi.fn(),
        releaseItems: vi.fn(),
        setCommandPending: vi.fn(),
        moveSentences: vi.fn(),
        moveToToken: vi.fn(),
        restartParagraph: vi.fn(),
        applySemanticAssist: vi.fn(),
        setLayoutGeneration: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        dispose: vi.fn(),
      };
    }),
    newSessionId: () => '11111111-1111-4111-8111-111111111111',
  };
});

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('../../../src/control/services/stage', () => stage);
vi.mock('../../../src/control/services/session-records', () => records);
vi.mock('../../../src/control/services/session', () => driver);
vi.mock('../../../src/control/services/voice-session', () => ({
  VoiceSessionPipeline: class {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    startListening(): void {}
    softPause(): void {}
    async hardPause(): Promise<void> {}
    async resume(): Promise<void> {}
    estimatedCostUsd(): number {
      return 0;
    }
  },
  COMMAND_TICK_INTERVAL_MS: 250,
}));

const {
  addTakeMarker,
  clearSession,
  goToToken,
  restartParagraph,
  startLiveSession,
  stopSession,
  takeHistory,
} = await import('../../../src/control/stores/session');

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function compiledStub(): CompiledScript {
  return {
    scriptId: 'script-1',
    sourceHash: 'hash-abc',
    // Three blocks, so "which sections did this pass reach" has more than one
    // answer. Sections are DERIVED from the reported position now — the engine
    // reports where the reader is and nothing about document structure — so a
    // stub with one block could not tell a working derivation from a broken one.
    sentences: [
      { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 29, text: 'One.' },
      { id: 's-2', blockId: 'b-2', startTokenIndex: 30, endTokenIndex: 79, text: 'Two.' },
      { id: 's-3', blockId: 'b-3', startTokenIndex: 80, endTokenIndex: 199, text: 'Three.' },
    ],
    navigationTargets: [],
    spokenTokens: [],
    literalCommandRanges: [],
    outline: [],
  } as unknown as CompiledScript;
}

function start(): void {
  startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    // Manual mode: no realtime transport, and the take history is not a voice
    // feature — a manual take has a history too.
    mode: 'manual',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: SESSION_ID,
    compiled: compiledStub(),
    sessionGeneration: 4,
  });
}

/**
 * Push one alignment snapshot at `tokenIndex`.
 *
 * `blockId` survives as a caller-facing label only: the engine reports
 * positions, and which block a position falls in is a property of the rendered
 * document rather than of the snapshot.
 */
function snapshot(
  _blockId: string,
  tokenIndex: number,
  extra: { confidence?: number; decision?: AlignmentSnapshot['decision'] } = {},
): void {
  driver.captured.onSnapshot?.({
    sessionGeneration: 4,
    seq: tokenIndex,
    state: 'following',
    decision: extra.decision ?? 'localConfirmed',
    confirmedToken: tokenIndex,
    observedToken: tokenIndex,
    rateTokensPerSecond: 2.5,
    evidenceAudioMs: 1_000 + tokenIndex,
    atAudioMs: 1_000 + tokenIndex,
    maxPredictionMs: 900,
  pauseOnsetMs: 1800,
  leadFloorMs: 550,
  maxLeadTokens: 2.5,
  leadMarginTokens: 1.2,
  leadEaseMs: 450,
  leadHoldMs: 0,
  leadDecayMs: 1200,
  displayLimitToken: 200,
    confidence: extra.confidence ?? 0.9,
    suggestionToken: null,
    scriptLenTokens: 200,
    observedAtom: tokenIndex,
    confirmedAtom: tokenIndex,
  } satisfies AlignmentSnapshot);
}

/** Every `record_session_take` payload written so far, in order. */
function writtenTakes(): Array<Record<string, unknown>> {
  return records.recordSessionTake.mock.calls.map(
    (call) => (call as unknown as [string, Record<string, unknown>])[1],
  );
}

describe('§36.3 take history', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    records.recordSessionTake.mockClear();
    driver.captured.onSnapshot = null;
    start();
  });

  afterEach(() => {
    clearSession();
    vi.useRealTimers();
  });

  it('round-trips a take with its times, sections and checkpoints', () => {
    snapshot('b-1', 10);
    addTakeMarker();
    snapshot('b-2', 40);
    snapshot('b-2', 55);
    snapshot('b-3', 90);
    stopSession();

    const takes = writtenTakes();
    expect(takes).toHaveLength(1);
    const take = takes[0]!;
    expect(take.passOrdinal).toBe(1);
    expect(take.takePassId).toBe(`${SESSION_ID}:1`);
    expect(take.startTokenIndex).toBe(0);
    expect(take.endTokenIndex).toBe(90);
    expect(typeof take.startedAt).toBe('string');
    expect(typeof take.endedAt).toBe('string');
    expect(typeof take.durationMs).toBe('number');
    // Sections traversed, in the order they were first reached, deduplicated.
    expect(take.sections).toEqual(['b-1', 'b-2', 'b-3']);
    const checkpoints = take.checkpoints as Array<Record<string, unknown>>;
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.kind).toBe('take');
    expect(checkpoints[0]!.tokenIndex).toBe(10);
    expect(checkpoints[0]!.blockId).toBe('b-1');
  });

  it('records an outline jump as a checkpoint', () => {
    snapshot('b-1', 12);
    goToToken(300);
    stopSession();

    const checkpoints = writtenTakes()[0]!.checkpoints as Array<Record<string, unknown>>;
    expect(checkpoints.map((c) => c.kind)).toEqual(['manual']);
  });

  /* -------- the assertion the whole feature exists for -------- */

  it('a second take does not overwrite the first', () => {
    snapshot('b-1', 10);
    addTakeMarker();
    snapshot('b-2', 60);

    // A retake closes the pass that was running and opens the next.
    restartParagraph();

    snapshot('b-2', 65);
    snapshot('b-3', 120);
    stopSession();

    const takes = writtenTakes();
    expect(takes).toHaveLength(2);

    const [first, second] = takes as [Record<string, unknown>, Record<string, unknown>];
    expect(first.passOrdinal).toBe(1);
    expect(second.passOrdinal).toBe(2);
    expect(first.takePassId).not.toBe(second.takePassId);

    // The first take kept its own sections and its own checkpoints...
    expect(first.sections).toEqual(['b-1', 'b-2']);
    expect((first.checkpoints as unknown[]).map((c) => (c as { kind: string }).kind)).toEqual([
      'take',
      'paragraph_start',
    ]);
    // ...and the second one starts empty rather than inheriting them.
    expect(second.sections).toEqual(['b-2', 'b-3']);
    expect(second.checkpoints).toEqual([]);
    expect(second.startTokenIndex).toBe(60);
    expect(second.endTokenIndex).toBe(120);
  });

  it('opens a third pass after a second retake', () => {
    snapshot('b-1', 5);
    restartParagraph();
    snapshot('b-1', 8);
    restartParagraph();
    snapshot('b-1', 11);
    stopSession();

    expect(writtenTakes().map((t) => t.passOrdinal)).toEqual([1, 2, 3]);
  });

  it('writes nothing twice when the session is stopped twice', () => {
    snapshot('b-1', 10);
    stopSession();
    stopSession();
    expect(writtenTakes()).toHaveLength(1);
  });
});

describe('§36.3 the in-memory history the spec asks for', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    records.recordSessionTake.mockClear();
    driver.captured.onSnapshot = null;
    start();
  });

  afterEach(() => {
    clearSession();
    vi.useRealTimers();
  });

  it('exposes the open take while the session runs', () => {
    snapshot('b-1', 10);
    const history = takeHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.open).toBe(true);
    expect(history[0]!.passOrdinal).toBe(1);
    expect(history[0]!.sections).toEqual(['b-1']);
  });

  it('keeps closed passes alongside the open one', () => {
    snapshot('b-1', 10);
    restartParagraph();
    snapshot('b-2', 40);
    const history = takeHistory();
    expect(history.map((t) => t.open)).toEqual([false, true]);
  });

  it('summarises confidence per pass, and reports unknown as null', () => {
    snapshot('b-1', 10, { confidence: 0.4 });
    snapshot('b-1', 20, { confidence: 0.8 });
    expect(takeHistory()[0]!.confidenceMean).toBeCloseTo(0.6, 6);

    // A pass that never saw a snapshot has no confidence — not zero.
    restartParagraph();
    expect(takeHistory()[1]!.confidenceMean).toBeNull();
  });

  it('counts automatic retake transitions without opening a pass', () => {
    snapshot('b-1', 30);
    snapshot('b-1', 12, { decision: 'retakeAccepted' });
    snapshot('b-1', 14, { decision: 'retakeAccepted' });
    const history = takeHistory();
    // The aligner decided the presenter re-read; that is not a new take.
    expect(history).toHaveLength(1);
    expect(history[0]!.automaticRetakes).toBe(2);

    stopSession();
    expect(writtenTakes()[0]!.automaticRetakes).toBe(2);
    expect(writtenTakes()[0]!.confidenceMean).toBeCloseTo(0.9, 6);
  });

  it('is discarded when the next session starts', () => {
    snapshot('b-1', 10);
    restartParagraph();
    expect(takeHistory()).toHaveLength(2);
    stopSession();
    start();
    expect(takeHistory()).toHaveLength(1);
  });
});
