/**
 * The two lanes that key take-scoped state must name the same pass identically.
 *
 * The §36.3 take history (`stores/session.ts`) and the coaching subsystem
 * (`services/coaching-session.ts`) both hold "the current take pass", and both
 * write it into things that outlive the take — a persisted `session_takes` row
 * on one side, a coaching report and every ribbon event and gutter mark on the
 * other. They used to mint it independently: the store advanced the ordinal on
 * a retake, and the coaching lane stamped `` `${sessionId}:1` `` for the whole
 * session and never moved.
 *
 * The other tests in this change prove each lane advances. This one proves the
 * two lanes *agree*, by putting the REAL store's persisted row next to the REAL
 * controller's minted id for the same ordinal. Both now come from
 * `takePassIdFor`, so drift means one of these assertions fails rather than a
 * review screen quietly failing to correlate.
 *
 * On revert of `takePassIdFor` the store's literal and the coaching lane's
 * literal are two independent spellings again, and nothing in the suite
 * compares them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompiledScript, TrackingSnapshot } from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
  publishStageDirective: vi.fn(async () => {}),
  publishListenerState: vi.fn(async () => {}),
  closeStage: vi.fn(async () => {}),
  getStageStatus: vi.fn(async () => ({
    exists: true,
    visible: true,
    fullscreen: true,
    stageGeneration: 2,
    hydrated: true,
    layoutReady: true,
    mediaHealthy: true,
  })),
}));

const records = vi.hoisted(() => ({
  appendSessionTranscript: vi.fn(async () => 0),
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
  recordSessionTake: vi.fn(async () => null),
  listSessionTakes: vi.fn(async () => []),
}));

const driver = vi.hoisted(() => {
  const captured: { onSnapshot: ((s: unknown) => void) | null } = { onSnapshot: null };
  return {
    captured,
    createTrackingDriver: vi.fn((deps: { onSnapshot: (s: unknown) => void }) => {
      captured.onSnapshot = deps.onSnapshot;
      return {
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
vi.mock('../../../src/control/services/smooth-follow-adapter', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/smooth-follow-adapter')>();
  return { ...actual, subscribeStageMotionAcks: () => () => {} };
});

const { clearSession, restartParagraph, startLiveSession, stopSession } = await import(
  '../../../src/control/stores/session'
);
const { CoachingSessionController } = await import(
  '../../../src/control/services/coaching-session'
);
const { takePassIdFor } = await import('../../../src/shared/coaching/take-pass');
const { defaultCoachingSettings } = await import('../../../src/control/lib/coaching-profiles');

type CoachingSessionDeps = ConstructorParameters<typeof CoachingSessionController>[0];

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function compiledStub(): CompiledScript {
  return {
    scriptId: 'script-1',
    sourceHash: 'hash-abc',
    sentences: [
      { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 3, text: 'Hello there.' },
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
    mode: 'manual',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: SESSION_ID,
    compiled: compiledStub(),
    sessionGeneration: 4,
    stageGeneration: 2,
  });
}

function snapshot(blockId: string, tokenIndex: number): void {
  driver.captured.onSnapshot?.({
    schemaVersion: 1,
    revision: tokenIndex,
    sessionId: SESSION_ID,
    sessionGeneration: 4,
    stageGeneration: 2,
    scriptId: 'script-1',
    tokenIndex,
    committedTokenIndex: tokenIndex,
    blockId,
    sentenceId: `s-${tokenIndex}`,
    confidence: 0.9,
    state: 'following',
    provisional: false,
    movement: 'advance',
    sourceItemIds: [],
    generatedAtMs: 1_000 + tokenIndex,
  } satisfies TrackingSnapshot);
}

/** Every `record_session_take` payload written so far, in order. */
function writtenTakes(): Array<Record<string, unknown>> {
  return records.recordSessionTake.mock.calls.map(
    (call) => (call as unknown as [string, Record<string, unknown>])[1],
  );
}

/** The coaching lane's id for a pass, taken from the real controller. */
function coachingIdForPass(passOrdinal: number): string {
  const controller = new CoachingSessionController({
    sessionId: SESSION_ID,
    settings: { ...defaultCoachingSettings(), mode: 'coach' },
    compiled: null,
    stream: {
      getAudioTracks: () => [{ kind: 'audio' }],
    } as unknown as CoachingSessionDeps['stream'],
    publish: () => {},
  });
  // The controller is never started, so no analyzer is opened; `beginTakePass`
  // is pure state on this path and this is exactly what a retake calls.
  if (passOrdinal > 1) controller.beginTakePass(passOrdinal);
  return controller.hostState().takePassId;
}

describe('§36.3 / §11.3 the take history and the coaching lane name the same pass', () => {
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

  it('writes the id the coaching lane would stamp, for every pass', () => {
    snapshot('b-1', 10);
    restartParagraph();
    snapshot('b-2', 40);
    restartParagraph();
    snapshot('b-3', 80);
    stopSession();

    const takes = writtenTakes();
    expect(takes.map((take) => take.passOrdinal)).toEqual([1, 2, 3]);

    for (const take of takes) {
      const ordinal = take.passOrdinal as number;
      expect(
        take.takePassId,
        `the persisted take row for pass ${ordinal} does not match the id the ` +
          'coaching rail stamps on its evidence for the same pass',
      ).toBe(coachingIdForPass(ordinal));
      // …and both are the one authoritative scheme, not two literals that
      // happen to agree today.
      expect(take.takePassId).toBe(takePassIdFor(SESSION_ID, ordinal));
    }
  });

  it('gives two passes two different ids', () => {
    snapshot('b-1', 10);
    restartParagraph();
    snapshot('b-2', 40);
    stopSession();

    const [first, second] = writtenTakes() as [Record<string, unknown>, Record<string, unknown>];
    expect(first.takePassId).not.toBe(second.takePassId);
    expect(coachingIdForPass(1)).not.toBe(coachingIdForPass(2));
  });
});
