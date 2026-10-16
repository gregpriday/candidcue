/**
 * The voice pill's wiring — the half the pure reducer cannot prove.
 *
 * `services/audio/voice-pill.ts` decides what the pill says and is tested on
 * its own. What is asserted here is that the decision reaches the stage at all
 * — `SessionState.voicePill`, which the embedded stage reads through its
 * `voicePill` prop. A take that publishes nothing leaves the presenter with no
 * indication that anything is being heard, which is the whole failure the pill
 * exists to end.
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
  StageVoicePillPayload,
} from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
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

const { setInvokeForTesting } = await import('../../../src/control/services/ipc');
const { clearSession, session, startLiveSession } = await import(
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

/**
 * Every pill payload handed to the stage, in order.
 *
 * Recorded off the session store because that is the stage's input: Live hands
 * `$session.voicePill` straight to the embedded stage's `voicePill` prop. Only
 * NEW payloads count — every other session update notifies subscribers too, and
 * counting those would make a silent publisher look busy.
 */
let published: StageVoicePillPayload[] = [];
let stopRecording: (() => void) | null = null;

function pills(): StageVoicePillPayload[] {
  return published;
}

function deps(): Record<string, (...args: never[]) => unknown> {
  const captured = pipeline.captured.deps;
  if (!captured) throw new Error('the voice pipeline was never constructed');
  return captured;
}

beforeEach(() => {
  vi.useFakeTimers();
  pipeline.captured.deps = null;
  setInvokeForTesting(async () => undefined as never);
  published = [];
  stopRecording = session.subscribe((s) => {
    if (s.voicePill !== null && s.voicePill !== published.at(-1)) published.push(s.voicePill);
  });
});

afterEach(() => {
  clearSession();
  stopRecording?.();
  stopRecording = null;
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
    // The embedded stage's own generation: there is no stage window.
    expect(first?.stageGeneration).toBe(0);
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
 * The recogniser's words reach the stage's transcript bar.
 *
 * Live hands `$session.transcriptTail.at(-1)` to the embedded stage's
 * `transcript` prop, so the session's tail is the bar's only source. The bar
 * once read "listening — no words yet" through a take that heard eleven words,
 * because its words travelled a road to a window that was not there.
 */
describe('transcript words reach the transcript bar', () => {
  it('lands each recogniser line on the session tail the stage reads', () => {
    start();
    const onTranscriptLine = deps().onTranscriptLine as unknown as (line: string) => void;
    onTranscriptLine('hello there friend');
    expect(get(session).transcriptTail.at(-1)).toContain('hello there friend');
  });
});
