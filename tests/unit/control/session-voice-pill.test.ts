/**
 * The voice pill's wiring — the half the pure reducer cannot prove.
 *
 * `services/audio/voice-pill.ts` decides what the pill says and is tested on
 * its own. What is asserted here is that the decision reaches the stage at all:
 * a take that publishes nothing leaves the presenter with no indication that
 * anything is being heard, which is the whole failure the pill exists to end.
 *
 * It also pins the two seams that are easy to break silently:
 *   • the waveform comes from the take's OWN capture (`onLevel` on the
 *     pipeline), never from a second `getUserMedia` — see
 *     `services/audio/ownership.ts` for the 9.8-second reason;
 *   • the publisher is a timer, not a level-frame callback, so the pill keeps
 *     reporting during the one failure where frames stop arriving.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AudioLevelSnapshot,
  CompiledScript,
  StageDirective,
  StageVoicePillPayload,
} from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  /* §64: the heartbeat compares what control sent against what the stage
     applied. `exists: false` means "no stage to compare with", which is the
     right answer for a mock that is not modelling a stage window. */
  getStageStatus: vi.fn(async () => ({ exists: false })),
  publishStageDirective: vi.fn(
    async (_sessionId: string, _stageGeneration: number, _directive: StageDirective) => {},
  ),
  closeStage: vi.fn(async () => {}),
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

/** The pipeline is stubbed so the test can drive its callbacks directly. */
const pipeline = vi.hoisted(() => {
  const captured: {
    deps: Record<string, (...args: never[]) => unknown> | null;
    /** Makes the NEXT pipeline's start reject, as a busy microphone would. */
    failNextStart: boolean;
  } = { deps: null, failNextStart: false };
  class FakePipeline {
    private readonly fails: boolean;
    constructor(deps: Record<string, (...args: never[]) => unknown>) {
      captured.deps = deps;
      this.fails = captured.failNextStart;
    }
    async start(): Promise<void> {
      if (this.fails) {
        // Long enough that the replacement take is already running, which is
        // the whole point: the retry can spend 1.75 s before giving up.
        await new Promise((resolve) => setTimeout(resolve, 150));
        throw new Error('MIC_DEVICE_LOST');
      }
    }
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
vi.mock('../../../src/control/services/alignment', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/alignment')>();
  return { ...actual, subscribeAlignmentSnapshots: () => () => {} };
});
vi.mock('../../../src/control/services/stage-acks', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/stage-acks')>();
  return { ...actual, subscribeStageMotionAcks: () => () => {} };
});

const { setInvokeForTesting } = await import('../../../src/control/services/ipc');
const { clearSession, session, setStageEmitterForTesting, startLiveSession } = await import(
  '../../../src/control/stores/session'
);
const { get } = await import('svelte/store');

function compiledStub(): CompiledScript {
  return {
    sourceHash: 'hash-abc',
    spokenTokens: [
      { index: 0, blockId: 'b-1', sentenceId: 's-1', surface: 'Hello', normalized: 'hello' },
    ],
    sentences: [
      { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 1, text: 'Hello there.' },
    ],
    navigationTargets: [],
    literalCommandRanges: [],
  } as unknown as CompiledScript;
}

function start(mode: 'voice' | 'manual' = 'voice'): void {
  startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode,
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: 'session-uuid-1',
    compiled: compiledStub(),
    stageGeneration: 4,
    sessionGeneration: 7,
    transcriptRetained: false,
  });
}

function frame(overrides: Partial<AudioLevelSnapshot> = {}): AudioLevelSnapshot {
  return {
    rms: 0.28,
    peak: 0.45,
    noiseFloor: 0.02,
    speaking: true,
    clipped: false,
    signalPresent: true,
    generatedAtMs: performance.now(),
    ...overrides,
  };
}

/** Every pill payload sent to the stage, in order. */
function pills(): StageVoicePillPayload[] {
  return stage.publishStageDirective.mock.calls
    .map(([, , directive]) => directive as StageDirective)
    .filter(
      (directive): directive is Extract<StageDirective, { kind: 'voicePill' }> =>
        directive.kind === 'voicePill',
    )
    .map((directive) => directive.pill);
}

function deps(): Record<string, (...args: never[]) => unknown> {
  const captured = pipeline.captured.deps;
  if (!captured) throw new Error('the voice pipeline was never constructed');
  return captured;
}

beforeEach(() => {
  vi.useFakeTimers();
  stage.publishStageDirective.mockClear();
  pipeline.captured.deps = null;
  setInvokeForTesting(async () => undefined as never);
  setStageEmitterForTesting(async () => {});
});

afterEach(() => {
  clearSession();
  setStageEmitterForTesting(null);
  setInvokeForTesting(null);
  vi.useRealTimers();
});

describe('the voice pill on a live take', () => {
  it('is on the stage before a single level frame has arrived', () => {
    /*
     * The device takes ~900 ms to acquire and can take much longer behind a
     * permission prompt. A pill that waited for its first frame would leave the
     * presenter with nothing on screen during exactly the stretch where they
     * are wondering whether the app is listening.
     */
    start();
    vi.advanceTimersByTime(100);
    const first = pills().at(0);
    expect(first?.stageGeneration).toBe(4);
    expect(first?.reading).toBe('listening');
    expect(first?.visible).toBe(true);
    expect(first?.label).toBe('Listening');
  });

  it('draws the waveform from the take’s own capture', () => {
    // §5.3 single-capture fan-out: the pipeline hands its level frames over,
    // and nothing here ever asks for a second microphone.
    start();
    const onLevel = deps().onLevel as unknown as (s: AudioLevelSnapshot) => void;
    expect(onLevel, 'the pipeline must publish level frames for the pill').toBeTypeOf('function');
    const at = performance.now();
    onLevel(frame({ generatedAtMs: at }));
    onLevel(frame({ generatedAtMs: at + 90, rms: 0.4 }));
    vi.advanceTimersByTime(100);
    const latest = pills().at(-1);
    expect(latest?.levels).toHaveLength(2);
    expect(latest?.levels.every((level) => level > 0 && level <= 1)).toBe(true);
  });

  it('turns into a tick when recogniser text comes back', () => {
    start();
    vi.advanceTimersByTime(100);
    expect(pills().at(-1)?.reading).toBe('listening');
    const onTranscriptText = deps().onTranscriptText as unknown as (
      text: string,
      final: boolean,
    ) => void;
    onTranscriptText('hello there', false);
    vi.advanceTimersByTime(100);
    expect(pills().at(-1)?.reading).toBe('confirmed');
    expect(pills().at(-1)?.label).toBe('Hearing you');
  });

  it('keeps publishing while nothing at all is happening', () => {
    /*
     * The publisher is a timer rather than the level callback, and this is why:
     * the failure worth catching is the one where frames STOP, and a publisher
     * driven by frames goes quiet during precisely that failure, freezing the
     * last healthy-looking reading on the stage.
     */
    start();
    vi.advanceTimersByTime(1000);
    expect(pills().length).toBeGreaterThanOrEqual(8);
  });

  it('says nothing on a manual take, which never opens a microphone', () => {
    start('manual');
    vi.advanceTimersByTime(1000);
    expect(pills()).toHaveLength(0);
  });

  it('ignores a superseded take reporting its own death', () => {
    /*
     * `stopInternals` does not await `pipeline.stop()`, and stopping is what
     * drives a pipeline to `offline`. So take A's teardown lands after take B
     * has started — and before the guard, it handed B a connection state
     * belonging to a session that no longer existed: a permanent "Not
     * connected" cross on the corner of a take that was working perfectly.
     */
    start();
    const takeA = deps();
    const reportA = takeA.onConnectionState as unknown as (state: string) => void;
    reportA('connected');

    start();
    vi.advanceTimersByTime(100);
    expect(pills().at(-1)?.reading).toBe('listening');

    reportA('offline');
    vi.advanceTimersByTime(200);
    expect(pills().at(-1)?.reading, 'take A may not fault take B').toBe('listening');
  });

  it('does not let a replaced take report its own failed start', async () => {
    /*
     * The microphone retry alone spends up to 1.75 s, so a superseded take can
     * still be inside `pipeline.start()` when its replacement is already
     * running. Its eventual rejection used to mark the CURRENT take offline,
     * raise a danger toast, and cross the pill — all describing a session the
     * operator had already ended.
     */
    pipeline.captured.failNextStart = true;
    start();
    pipeline.captured.failNextStart = false;
    start();
    vi.advanceTimersByTime(100);
    expect(pills().at(-1)?.reading).toBe('listening');

    await vi.advanceTimersByTimeAsync(200);
    expect(pills().at(-1)?.reading, 'the dead take may not fault the live one').toBe('listening');
  });

  it('a take whose pipeline never started does not claim a live microphone', async () => {
    /*
     * NEVER SHOW A CONFIDENT STATE YOU DO NOT HAVE.
     *
     * `micState` starts at 'live' and is only ever corrected by a running
     * pipeline. A start that REJECTED never opened a capture, so the status bar
     * reported "Mic live" over a take with no input at all — the same defect
     * the manual-mode pills were fixed for, on the one path where the operator
     * is already being told something went wrong.
     */
    pipeline.captured.failNextStart = true;
    start();
    pipeline.captured.failNextStart = false;
    await vi.advanceTimersByTimeAsync(200);

    expect(get(session).micState, 'no capture was opened').toBe('disconnected');
    expect(get(session).connection).toBe('offline');
  });

  it('does not offer an input picker for a failure the input did not cause', async () => {
    /*
     * §28.2. `inputDeviceLost` is what puts the mid-session picker on screen,
     * and swapping microphones cannot fix a refused credential. An affordance
     * that cannot help is the same unfollowable instruction as advice pointing
     * at a control that does not exist — the failure here is `MIC_DEVICE_LOST`,
     * so the picker IS the answer, and the sibling case is pinned in
     * tests/e2e/browser/live-voice-transport.spec.ts where the transport is
     * what died.
     */
    pipeline.captured.failNextStart = true;
    start();
    pipeline.captured.failNextStart = false;
    await vi.advanceTimersByTimeAsync(200);

    expect(get(session).inputDeviceLost, 'a MIC_ failure offers the picker').toBe(true);
  });

  it('stops when the session does', () => {
    start();
    vi.advanceTimersByTime(200);
    const before = pills().length;
    expect(before).toBeGreaterThan(0);
    clearSession();
    vi.advanceTimersByTime(1000);
    expect(pills()).toHaveLength(before);
  });
});

/**
 * The recogniser's words reach the stage by the road that works.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 * The transcript bar used to be fed by a direct
 * `emitTo('stage', 'stage://transcript-tap', …)` from the control webview. On a
 * real rig it delivered nothing: the bar read "listening — no words yet" for an
 * entire take while control counted six taps sent, in the same seconds that
 * alignment snapshots reached the same window and moved the document to the
 * pixel. Reading both sides never produced a reason they should differ — same
 * helper, same target, same generation, subscriptions registered together.
 *
 * What differed was the ROAD. Snapshots are emitted by RUST, and everything
 * Rust emits arrives. So the words go that way too, as a `transcript`
 * directive on `publish_stage_command` — the relay the stage already trusts for
 * freeze, blank, settings and calibration.
 *
 * This pins the control end of that. The stage end is pinned by
 * `tests/dom/stage-exit-affordance.test.ts`; between them the only untested
 * link is the Rust relay itself, which every working take already exercises.
 */
describe('transcript words travel the Rust relay', () => {
  it('publishes them as a directive rather than emitting at the window', () => {
    start();
    stage.publishStageDirective.mockClear();

    const onTranscriptText = deps().onTranscriptText as unknown as (
      text: string,
      final: boolean,
    ) => void;
    onTranscriptText('this is a test of the transcription', false);

    const calls = stage.publishStageDirective.mock.calls.filter(
      ([, , directive]) => (directive as { kind: string }).kind === 'transcript',
    );
    expect(calls, 'the words were not published as a transcript directive').toHaveLength(1);
    const directive = calls[0]![2] as { kind: string; text: string; final: boolean };
    expect(directive.text).toContain('this is a test of the transcription');
    expect(directive.final).toBe(false);
  });

  it('carries the words of a final the same way', () => {
    start();
    stage.publishStageDirective.mockClear();
    const onTranscriptText = deps().onTranscriptText as unknown as (
      text: string,
      final: boolean,
    ) => void;
    onTranscriptText('hello there friend', true);

    const directive = stage.publishStageDirective.mock.calls
      .map(([, , d]) => d as { kind: string; text: string; final: boolean })
      .find((d) => d.kind === 'transcript');
    expect(directive?.final).toBe(true);
    expect(directive?.text).toContain('hello there friend');
  });
});
