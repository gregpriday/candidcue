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
import { get } from 'svelte/store';
import { STAGE_EVENT } from '../../../src/shared/contracts';
import type { CompiledScript } from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  /* §64: the heartbeat compares what control sent against what the stage
     applied. `exists: false` means "no stage to compare with", which is the
     right answer for a mock that is not modelling a stage window. */
  getStageStatus: vi.fn(async () => ({ exists: false })),
  publishStageDirective: vi.fn(async () => {}),
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
  const captured: {
    deps: Record<string, (...args: never[]) => unknown> | null;
    /** The live instance, so a test can make one of its methods misbehave. */
    instance: unknown;
  } = { deps: null, instance: null };
  class FakePipeline {
    constructor(deps: Record<string, (...args: never[]) => unknown>) {
      captured.deps = deps;
      captured.instance = this;
    }
    async switchMicrophone(): Promise<void> {}
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
/*
 * A vi.mock of `services/semantic-sidecar` used to sit here.
 *
 * The OpenAI semantic sidecar was removed from the product; the module does
 * not exist. Nothing imports it, so the mock never applied and the factory
 * below it — a whole fake scheduler with token budgets and cost estimates —
 * was inert. It survived because a mock of a missing module is silent: vitest
 * only resolves the path if something asks for it. The repository completeness
 * gate (scripts/verify-repository.mjs) is what finally named it.
 */
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
const {
  clearSession,
  session,
  setStageEmitterForTesting,
  startLiveSession,
  startPrompting,
  stopSession,
} = await import('../../../src/control/stores/session');
const { toasts, clearToasts } = await import('../../../src/control/stores/toasts');

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
  /** 0 is single-window presentation: no separate stage window, no bridge. */
  stageGeneration?: number;
  sentences?: Array<{
    id: string;
    blockId: string;
    startTokenIndex: number;
    endTokenIndex: number;
    normalizedText: string;
  }>;
}

function start(overrides: StartOverrides = {}): string {
  return startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: overrides.mode ?? 'voice',
    displayLabel: 'Stage',
    outline: [],
    sentences: (overrides.sentences ?? []) as never,
    totalTokens: 200,
    sessionId: 'session-uuid-1',
    compiled: compiledStub(),
    stageGeneration: overrides.stageGeneration ?? 4,
    sessionGeneration: overrides.sessionGeneration ?? 7,
    transcriptRetained: overrides.transcriptRetained ?? false,
  });
}

const emitted: Array<{ target: string; event: string; payload: unknown }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  // Toasts are module state shared by every test in this file, and several
  // here count them. A test that raises one must not be able to change what
  // the next one sees.
  clearToasts();
  invoked.length = 0;
  setInvokeForTesting(async (command, args) => {
    invoked.push({ command, args });
    return undefined as never;
  });
  emitted.length = 0;
  records.appendSessionTranscript.mockClear();
  records.endSessionRecord.mockClear();
  pipeline.captured.deps = null;
  pipeline.captured.instance = null;
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

  /*
   * The late rejection, which is the only interesting one.
   *
   * `flushTranscript` clears the buffer before the write is acknowledged, so a
   * rejection has to put the items back — but the last flush of a take is
   * issued by `stopSession` itself, and its promise settles AFTER the take has
   * been torn down. Two versions of the guard got this wrong:
   *
   *   1. re-queue unconditionally — one take's transcript ended up in the next
   *      take's buffer, to be written under the wrong session id;
   *   2. re-queue when `state.sessionId` still matches — `stopSession` leaves
   *      the id in place, so the items went back into a buffer whose flush
   *      timer had been stopped (never retried) under a toast promising a
   *      retry, and the sticky degraded flag then marked the NEXT take's
   *      summary "partly saved".
   *
   * Both are behaviour a source scan cannot see, so they are driven here.
   */
  it('tells the truth when the last append fails after the take has ended', async () => {
    // A property rather than a `let`: TypeScript narrows a variable assigned
    // only inside the executor to `never`, and the call below stops compiling.
    const deferred: { reject?: (err: Error) => void } = {};
    records.appendSessionTranscript.mockImplementationOnce(
      () =>
        new Promise<number>((_resolve, reject) => {
          deferred.reject = (err: Error) => reject(err);
        }),
    );

    start({ transcriptRetained: true });
    startPrompting();
    finalizeSpeech();
    /*
     * The take ends. This issues the final append, which has not settled.
     *
     * Deliberately NOT followed by `clearSession()`: that nulls the session
     * id, and the whole point is that `stopSession` on its own leaves the id
     * in place while the take is over and the flush timer is stopped.
     */
    stopSession();

    // ...and now the write fails, with nothing left that could retry it.
    deferred.reject?.(new Error('disk full'));
    await vi.advanceTimersByTimeAsync(0);

    const raised = get(toasts);
    expect(raised, 'the presenter must be told').toHaveLength(1);
    expect(raised[0]!.tone).toBe('danger');
    /*
     * The wording is the assertion. Comparing `state.sessionId` treated this
     * as "the same take", so the items went back into a buffer whose flush
     * timer had already been stopped and the toast promised a retry that could
     * not happen. Nothing would ever have contradicted it.
     */
    expect(raised[0]!.message, 'a retry that cannot happen must not be promised').not.toMatch(
      /keep trying/i,
    );
    expect(raised[0]!.message).toMatch(/missing from the saved transcript/i);

    // A second take, whose writes all succeed, is unaffected.
    records.appendSessionTranscript.mockClear();
    start({ transcriptRetained: true });
    startPrompting();
    finalizeSpeech();
    const second = stopSession();
    expect(second.transcriptSaved).toBe(true);
    expect(second.transcriptPartial).toBe(false);
    expect(records.appendSessionTranscript).toHaveBeenCalledTimes(1);
    const [, items] = records.appendSessionTranscript.mock.calls[0] as unknown as [
      string,
      Array<{ commitSequence: number }>,
    ];
    expect(items, 'the dead take’s items must not be written under the new take').toHaveLength(2);
  });

  it('reports a mid-take append failure on the take that owns it', async () => {
    /*
     * The other side of the same guard: while the take is still running, the
     * items DO go back in the buffer and the summary says the transcript is
     * only partly saved.
     */
    records.appendSessionTranscript.mockImplementationOnce(async () => {
      throw new Error('disk full');
    });

    start({ transcriptRetained: true });
    startPrompting();
    finalizeSpeech();
    // The periodic flush, mid-take — not the one `stopSession` issues.
    await vi.advanceTimersByTimeAsync(20_000);

    const summary = stopSession();
    expect(summary.transcriptPartial, 'the take that lost items must say so').toBe(true);
    expect(summary.transcriptSaved).toBe(false);
    // And the items were retried rather than dropped: the second call carries
    // the same two commit sequences.
    expect(records.appendSessionTranscript.mock.calls.length).toBeGreaterThan(1);
    const retried = records.appendSessionTranscript.mock.calls.at(-1) as unknown as [
      string,
      Array<{ commitSequence: number }>,
    ];
    expect(retried[1].map((i) => i.commitSequence)).toEqual([1, 2]);
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

/**
 * §115 — the summary has to know whether silence on the stage bridge was
 * EXPECTED.
 *
 * Stage updates, document travel and the transcript relay are all measured
 * across the control→stage window boundary, and `startStageBridge` returns
 * immediately at generation 0 — single-window presentation, which is the
 * configuration most takes run in. Every one of those counters therefore reads
 * empty on a perfectly healthy embedded take, and the summary reported all
 * three as faults. On revert, this flag goes back to being unavailable and the
 * dialog resumes accusing the app of three failures per take.
 */
describe('§115 — stage telemetry is only expected when a stage window exists', () => {
  it('does not expect telemetry in single-window presentation (generation 0)', () => {
    start({ stageGeneration: 0 });
    startPrompting();
    const summary = stopSession();
    expect(summary.stageTelemetryExpected).toBe(false);
    /*
     * And the counters really are empty — this is the state that used to read
     * as three separate faults, so it is worth pinning that the flag is
     * describing the real situation rather than papering over a live bridge.
     */
    expect(summary.stageApplied).toBeNull();
    expect(summary.documentTravelPx).toBeNull();
  });

  it('expects telemetry when the stage has its own window', () => {
    start({ stageGeneration: 4 });
    startPrompting();
    const summary = stopSession();
    expect(summary.stageTelemetryExpected).toBe(true);
  });

  it('reports no telemetry for a stop that had no session to stop', () => {
    // `emptySummary` — the shape-complete zero. A missing field here would make
    // the summary render the separate-window rows against zeroed counters.
    const summary = stopSession();
    expect(summary.stageTelemetryExpected).toBe(false);
  });

  // The "a separate stage that DIED mid-take still expects telemetry" case
  // needs the bridge's real `stage://closed` listener, so it lives in
  // `session-stage-bridge.test.ts` where that harness already exists.
});

/**
 * §115 — the ending location is presenter-facing copy, so it may not be in
 * engine units.
 *
 * `Token 417` is a measured span index. It is not a word count, it appears
 * nowhere else the presenter can see, and nobody reading the summary can
 * convert it into anything. The heading is used when there is one; this covers
 * the fallback, which is what a script with no headings always hit.
 */
describe('§115 — the ending location never reports a raw token index', () => {
  const sentences = [
    { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 3, normalizedText: 'Hello there.' },
    { id: 's-2', blockId: 'b-1', startTokenIndex: 4, endTokenIndex: 9, normalizedText: 'Second one.' },
  ];

  function pushSnapshot(confirmedToken: number): void {
    alignmentFeed.push?.({
      sessionGeneration: 7,
      seq: 1,
      state: 'following',
      decision: 'localConfirmed',
      confirmedToken,
      observedToken: confirmedToken + 1,
      rateTokensPerSecond: 2.5,
      evidenceAudioMs: 1000,
      atAudioMs: 1000,
      maxPredictionMs: 900,
      confidence: 0.9,
      suggestionToken: null,
      scriptLenTokens: 200,
      observedAtom: confirmedToken + 1,
      confirmedAtom: confirmedToken,
    });
  }

  it('locates the ending by sentence when the script has no headings', () => {
    start({ sentences });
    startPrompting();
    pushSnapshot(5);
    const summary = stopSession();

    expect(summary.endingLocation).not.toMatch(/token/i);
    expect(summary.endingLocation).toBe('Sentence 2 of 2');
  });

  it('still says Beginning before anything has been followed', () => {
    start({ sentences });
    startPrompting();
    const summary = stopSession();
    expect(summary.endingLocation).toBe('Beginning');
  });

  it('says Beginning when the take never reached the first sentence', () => {
    /*
     * The `reached === 0` branch, which needs a SNAPSHOT to get to — the test
     * above returns at `!snapshot` and never exercises it. Degraded input (a
     * first sentence that does not start at token 0) is what reaches this, and
     * flooring it to "Sentence 1 of 2" would name a sentence never begun.
     */
    start({ sentences: [{ ...sentences[0]!, startTokenIndex: 40, endTokenIndex: 48 }] });
    startPrompting();
    pushSnapshot(3);
    expect(stopSession().endingLocation).toBe('Beginning');
  });

  it('says the location is unavailable rather than inventing one', () => {
    // Degraded input: a snapshot arrived but there is no sentence metadata to
    // locate it against. "Beginning" would be a claim; this is not.
    start({ sentences: [] });
    startPrompting();
    pushSnapshot(5);
    expect(stopSession().endingLocation).toBe('Location unavailable');
  });
});

/**
 * §115 — an instruction the operator can actually carry out.
 *
 * The busy-device fallback notice says "pick another input in the take
 * controls". Two things had to be true for that to mean anything, and neither
 * was: the notice had to outlive the four-second `info` default (it is an
 * instruction, and the take runs for minutes), and the picker it names had to
 * render — which it did not, because the picker was gated on `inputDeviceLost`
 * and a fallback loses nothing.
 */
describe('§115 — the fallback-input notice is followable', () => {
  function fellBackToDefault(): void {
    const deps = pipeline.captured.deps as unknown as {
      onInputFellBackToDefault?: () => void;
    };
    deps.onInputFellBackToDefault?.();
  }

  it('offers the picker without claiming the microphone failed', () => {
    start();
    startPrompting();
    fellBackToDefault();

    const s = get(session);
    // The flag the picker reads...
    expect(s.usingFallbackInput).toBe(true);
    // ...and NOT the one that means "this is broken". Nothing failed: audio is
    // being captured, just not from the chosen device.
    expect(s.inputDeviceLost).toBe(false);
    expect(s.micState).toBe('live');
  });

  it('does not expire while the take is still running', () => {
    start();
    startPrompting();
    fellBackToDefault();
    expect(get(toasts)).toHaveLength(1);

    // Well past the 4000 ms `info` default that used to retire it.
    vi.advanceTimersByTime(30_000);
    expect(get(toasts)).toHaveLength(1);
  });

  it('reports the condition once rather than stacking', () => {
    start();
    startPrompting();
    fellBackToDefault();
    fellBackToDefault();
    expect(get(toasts)).toHaveLength(1);
  });

  it('is retired with the take', () => {
    start();
    startPrompting();
    fellBackToDefault();
    stopSession();
    expect(get(toasts)).toHaveLength(0);
  });

  it('ignores a fallback reported by a superseded pipeline', () => {
    start();
    startPrompting();
    const deps = pipeline.captured.deps as unknown as {
      onInputFellBackToDefault?: () => void;
    };
    stopSession();
    clearSession();

    // The old take's pipeline, reporting late. Nothing it says belongs to what
    // is on screen now.
    deps.onInputFellBackToDefault?.();
    expect(get(toasts)).toHaveLength(0);
    expect(get(session).usingFallbackInput).toBe(false);
  });

  /**
   * A resolved switch is not necessarily the device that was asked for.
   *
   * The pipeline falls back to the system default when the REPLACEMENT is also
   * busy, and reports that by callback rather than by rejecting. Treating it as
   * success took the picker away and announced that following had resumed, for
   * a device the operator had chosen and silently not been given.
   */
  it('does not claim success when the replacement input also fell back', async () => {
    start();
    startPrompting();

    const deps = pipeline.captured.deps as unknown as {
      onInputFellBackToDefault?: () => void;
    };
    const { switchMicrophone } = await import('../../../src/control/stores/session');

    // The fake pipeline's `switchMicrophone` falls back while switching.
    const live = pipeline.captured.instance as unknown as {
      switchMicrophone: (deviceId: string) => Promise<void>;
    };
    live.switchMicrophone = async () => {
      deps.onInputFellBackToDefault?.();
    };

    const ok = await switchMicrophone('device-b', 'Interface B');
    expect(ok).toBe(false);
    // Still offering the remedy, still saying why, still capturing.
    expect(get(session).usingFallbackInput).toBe(true);
    expect(get(session).micState).toBe('live');
    expect(get(toasts)).toHaveLength(1);
  });
});
