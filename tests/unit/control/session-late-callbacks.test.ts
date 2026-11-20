/**
 * #244 — a take's pipeline speaks only for that take.
 *
 * `stopInternals` starts `pipeline.stop()` without awaiting it, and the
 * pipeline deliberately keeps applying frames from the recogniser session it
 * is closing so the last utterance can finalise. Those frames reach the
 * store's callbacks for up to a few seconds after the stop — long enough to
 * overlap a quick restart. By then the store's module-level state belongs to
 * the next take, so a late callback that is not turned away writes into it.
 *
 * Every case here drives a callback, or an async continuation, of a take that
 * has ended, and asserts that the take running now — its state, its summary
 * counters, its toasts and its following — is exactly as it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompiledScript } from '../../../src/shared/contracts';
import type { DisplayDescriptor } from '../../../src/control/services/stage-types';

/** Display probes still in flight, oldest first; a test answers them. */
const probes = vi.hoisted(() => [] as Array<(display: { fingerprint: string; name: string }) => void>);

const stage = vi.hoisted(() => ({
  listDisplays: vi.fn(async () => [{ fingerprint: 'display-0' }]),
  currentWindowDisplay: vi.fn(
    () =>
      new Promise<{ fingerprint: string; name: string }>((resolve) => {
        probes.push(resolve);
      }),
  ),
}));

const records = vi.hoisted(() => ({
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
}));

type Deps = Record<string, (...args: never[]) => unknown>;

/** The pipeline is stubbed so the test can drive its callbacks directly. */
const pipeline = vi.hoisted(() => {
  const captured: {
    /** Every pipeline's callbacks, in construction order. */
    all: Deps[];
    /** Makes the NEXT pipeline's start reject, late, with this. */
    startError: unknown;
    /** Makes every hard pause reject, late, with this. */
    hardPauseError: unknown;
    /** How long a resume takes to answer, and what it rejects with. */
    resumeDelayMs: number;
    resumeError: unknown;
    /** Run synchronously inside `stop()`, as a closing session's last frame. */
    onStop: ((deps: Deps) => void) | null;
    /**
     * Whether a switch swaps a running capture. False is a pipeline whose start
     * failed, which the store answers by reopening it with `resume()`.
     */
    switchOpens: boolean;
    /** What a switch rejects with, when anything. */
    switchError: unknown;
    /** Every `resume()`, by the index of the pipeline it was called on. */
    resumedBy: number[];
  } = {
    all: [],
    startError: null,
    hardPauseError: null,
    resumeDelayMs: 0,
    resumeError: null,
    onStop: null,
    switchOpens: true,
    switchError: null,
    resumedBy: [],
  };
  class FakePipeline {
    private readonly deps: Deps;
    private readonly startError: unknown;
    constructor(deps: Deps) {
      this.deps = deps;
      captured.all.push(deps);
      this.startError = captured.startError;
    }
    async start(): Promise<void> {
      if (this.startError === null) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
      throw this.startError;
    }
    async stop(): Promise<void> {
      captured.onStop?.(this.deps);
    }
    startListening(): void {}
    softPause(): void {}
    async hardPause(): Promise<void> {
      if (captured.hardPauseError === null) return;
      const error = captured.hardPauseError;
      await new Promise((resolve) => setTimeout(resolve, 150));
      throw error;
    }
    async switchMicrophone(): Promise<boolean> {
      // Each call's outcome is fixed when it is made, not when it answers.
      const error = captured.switchError;
      const opens = captured.switchOpens;
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (error !== null) throw error;
      return opens;
    }
    async resume(): Promise<void> {
      captured.resumedBy.push(captured.all.indexOf(this.deps));
      const delay = captured.resumeDelayMs;
      const error = captured.resumeError;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (error !== null) throw error;
    }
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
vi.mock('../../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});
/** Every tracking driver's options, so a test can call an old take's feed. */
const drivers = vi.hoisted(
  () =>
    [] as Array<{ onSnapshot(snapshot: unknown): void; onTranscript(line: string): void }>,
);
vi.mock('../../../src/control/services/session', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/session')>();
  return {
    ...actual,
    createTrackingDriver: (options: Parameters<typeof actual.createTrackingDriver>[0]) => {
      drivers.push(options as unknown as (typeof drivers)[number]);
      return actual.createTrackingDriver(options);
    },
  };
});
vi.mock('../../../src/control/services/alignment', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/alignment')>();
  return { ...actual, subscribeAlignmentSnapshots: () => () => {} };
});

const { setInvokeForTesting } = await import('../../../src/control/services/ipc');
const {
  clearSession,
  hardPause,
  resumeSession,
  retryMicrophone,
  session,
  startLiveSession,
  stopSession,
  switchMicrophone,
} = await import('../../../src/control/stores/session');
const { smoothFollow } = await import('../../../src/control/stores/smooth-follow');
const { get } = await import('svelte/store');
const { clearToasts, toasts } = await import('../../../src/control/stores/toasts');

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

let takes = 0;

/** Start a voice take and hand back its pipeline's callbacks. */
function start(
  options: { sessionId?: string; stageDisplay?: DisplayDescriptor } = {},
): Deps {
  takes += 1;
  const pipelinesBefore = pipeline.captured.all.length;
  startLiveSession({
    ...options,
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'voice',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: options.sessionId ?? `session-${takes}`,
    compiled: compiledStub(),
    sessionGeneration: takes,
  });
  const deps = pipeline.captured.all.at(-1);
  if (!deps || pipeline.captured.all.length !== pipelinesBefore + 1) {
    throw new Error('the take did not construct exactly one voice pipeline');
  }
  return deps;
}

/** A callback off a captured pipeline, typed loosely enough to call. */
function cb<A extends unknown[]>(deps: Deps, name: string): (...args: A) => void {
  const fn = deps[name];
  if (typeof fn !== 'function') throw new Error(`the pipeline was given no ${name}`);
  return fn as unknown as (...args: A) => void;
}

/** The parts of a take's state a late callback could reach. */
function takeState(): Record<string, unknown> {
  const s = get(session);
  return {
    sessionId: s.sessionId,
    active: s.active,
    connection: s.connection,
    micState: s.micState,
    inputDeviceLost: s.inputDeviceLost,
    usingFallbackInput: s.usingFallbackInput,
    microphoneRefused: s.microphoneRefused,
    paused: s.paused,
    transcriptTail: s.transcriptTail,
    heardAnything: s.heardAnything,
    counts: s.counts,
    voiceFollowingAvailable: s.voiceFollowingAvailable,
  };
}

/**
 * Everything the old take's pipeline might still say, one event each. Word
 * counts differ from the new take's own (one final word, two in flight), so a
 * stale event that reached the counters cannot hide behind a coincidence.
 */
const LATE_EVENTS: Array<[string, (old: Deps) => void]> = [
  ['a final', (old) => cb<[string, boolean]>(old, 'onTranscriptText')('one two three four', true)],
  ['a partial', (old) => cb<[string, boolean]>(old, 'onTranscriptText')('five six seven', false)],
  ['a transcript line', (old) => cb<[string]>(old, 'onTranscriptLine')('a line from the last take')],
  ['a transcript reset', (old) => cb<[]>(old, 'onResetTranscriptState')()],
  ['a following hold', (old) => cb<[boolean, string]>(old, 'onFollowingHold')(true, 'stale')],
  ['a device loss', (old) => cb<[string]>(old, 'onInputDeviceLost')('MIC_DEVICE_LOST')],
  ['a session failure', (old) => cb<[string, boolean]>(old, 'onSessionFailure')('STT_SESSION_FAILED', true)],
  ['dropped audio', (old) => cb<[number]>(old, 'onAudioDropped')(3)],
  ['a pause warning', (old) => cb<[number]>(old, 'onPauseWarning')(0)],
  ['a connection state', (old) => cb<[string]>(old, 'onConnectionState')('offline')],
  ['an input fallback', (old) => cb<['missing']>(old, 'onInputFellBackToDefault')('missing')],
  ['a pinned microphone found', (old) => cb<[string, string]>(old, 'onPinnedMicrophoneFound')('mic-x', 'Mic X')],
];

function speakLate(old: Deps): void {
  for (const [, deliver] of LATE_EVENTS) deliver(old);
}

/**
 * Take B, mid-take: one final word heard, two in flight, a line on the tail,
 * connected, and on a fallback input with its notice up — so a stale event
 * that cleared any of it shows as clearly as one that added to it.
 */
function seedLiveTake(b: Deps): void {
  cb<[string]>(b, 'onConnectionState')('connected');
  cb<[string, boolean]>(b, 'onTranscriptText')('hello', true);
  cb<[string]>(b, 'onTranscriptLine')('hello');
  cb<[string, boolean]>(b, 'onTranscriptText')('two words', false);
  cb<['busy']>(b, 'onInputFellBackToDefault')('busy');
}

beforeEach(() => {
  vi.useFakeTimers();
  pipeline.captured.all = [];
  pipeline.captured.startError = null;
  pipeline.captured.hardPauseError = null;
  pipeline.captured.resumeDelayMs = 0;
  pipeline.captured.resumeError = null;
  pipeline.captured.onStop = null;
  probes.length = 0;
  drivers.length = 0;
  pipeline.captured.switchOpens = true;
  pipeline.captured.switchError = null;
  pipeline.captured.resumedBy = [];
  setInvokeForTesting(async () => undefined as never);
  clearToasts();
});

afterEach(() => {
  pipeline.captured.onStop = null;
  clearSession();
  clearToasts();
  setInvokeForTesting(null);
  vi.useRealTimers();
});

describe('late callbacks from an ended take (#244)', () => {
  it('a final delivered after the stop reaches neither that summary nor the next take', () => {
    const a = start();
    cb<[string, boolean]>(a, 'onTranscriptText')('hello there', true);
    const summaryA = stopSession();
    expect(summaryA.wordsHeard).toBe(2);
    const afterStop = takeState();

    // The closing recogniser finalises the last utterance after the stop.
    cb<[string, boolean]>(a, 'onTranscriptText')('and one more thing', true);
    cb<[string]>(a, 'onTranscriptLine')('and one more thing');
    expect(takeState(), 'a stopped take does not keep transcribing').toEqual(afterStop);

    start();
    const summaryB = stopSession();
    expect(summaryB.wordsHeard).toBe(0);
    expect(summaryB.wordsInFlight).toBe(0);
  });

  it('a quick stop and restart leaves the new take untouched by the old pipeline', () => {
    const a = start();
    stopSession();
    const b = start();
    seedLiveTake(b);
    const before = takeState();
    const toastsBefore = get(toasts);
    expect(toastsBefore, 'the new take has its own fallback notice').toHaveLength(1);

    speakLate(a);

    expect(takeState()).toEqual(before);
    expect(get(smoothFollow).followingPaused, 'a stale hold may not pause this take').toBe(false);
    expect(get(toasts), 'nothing is said about a take that is over').toEqual(toastsBefore);

    const summary = stopSession();
    expect(summary.wordsHeard).toBe(1);
    expect(summary.wordsInFlight).toBe(2);
  });

  it.each(LATE_EVENTS)('%s from the replaced take changes nothing on the new one', (_, deliver) => {
    const a = start();
    stopSession();
    const b = start();
    seedLiveTake(b);
    const before = takeState();
    const toastsBefore = get(toasts);

    deliver(a);

    expect(takeState()).toEqual(before);
    expect(get(smoothFollow).followingPaused).toBe(false);
    expect(get(toasts)).toEqual(toastsBefore);
    const summary = stopSession();
    expect(summary.wordsHeard).toBe(1);
    expect(summary.wordsInFlight).toBe(2);
  });

  it('the old take’s tracking driver cannot feed the new take', () => {
    start();
    const driverA = drivers.at(-1)!;
    stopSession();
    start();
    const driverB = drivers.at(-1)!;
    expect(driverB).not.toBe(driverA);
    const before = get(session);

    driverA.onTranscript('a line from the last take');
    driverA.onSnapshot({ ...(before.snapshot ?? {}), confirmedToken: 120, observedToken: 120 });
    expect(get(session).transcriptTail).toEqual(before.transcriptTail);
    expect(get(session).snapshot).toBe(before.snapshot);
    expect(get(session).heardAnything).toBe(before.heardAnything);

    // The new take's own feed still lands.
    driverB.onTranscript('this take');
    expect(get(session).transcriptTail).toEqual(['this take']);
  });

  it('a following hold delivered after a quick stop and restart does not pause the new take', () => {
    const a = start();
    stopSession();
    const b = start();
    cb<[boolean, string]>(a, 'onFollowingHold')(true, 'stale');
    expect(get(smoothFollow).followingPaused).toBe(false);
    // The new take's own hold still holds.
    cb<[boolean, string]>(b, 'onFollowingHold')(true, 'live');
    expect(get(smoothFollow).followingPaused).toBe(true);
  });

  it('a device lost after the restart does not disconnect the new take', () => {
    const a = start();
    // Replaced directly, with no stop between: "Present again".
    const b = start();
    cb<[string]>(a, 'onInputDeviceLost')('MIC_DEVICE_LOST');
    expect(get(session).micState).toBe('live');
    expect(get(session).inputDeviceLost).toBe(false);

    // And a restore from the old pipeline does not clear the new take's real loss.
    cb<[string]>(b, 'onInputDeviceLost')('MIC_DEVICE_LOST');
    cb<[]>(a, 'onInputRestored')();
    expect(get(session).inputDeviceLost).toBe(true);
    expect(get(session).micState).toBe('disconnected');
  });

  it('a session failure after the restart does not take the new take offline', () => {
    const a = start();
    stopSession();
    const b = start();
    cb<[string]>(b, 'onConnectionState')('connected');
    clearToasts();
    cb<[string, boolean]>(a, 'onSessionFailure')('STT_SESSION_FAILED', true);
    expect(get(session).connection).toBe('connected');
    expect(get(session).micState).toBe('live');
    expect(get(toasts)).toEqual([]);
  });

  it('a start that rejects after its take was replaced reports nothing', async () => {
    pipeline.captured.startError = { code: 'MIC_DEVICE_LOST', userMessage: 'gone' };
    start();
    pipeline.captured.startError = null;
    start();
    const before = takeState();
    clearToasts();
    await vi.advanceTimersByTimeAsync(200);
    expect(takeState()).toEqual(before);
    expect(get(toasts)).toEqual([]);
  });

  it('a callback the closing pipeline fires during the stop itself is ignored', () => {
    /*
     * The token is invalidated before teardown begins. A last frame delivered
     * from inside `stop()` — or anything else that runs during `stopInternals`
     * — must not count as the live take: `clearConditionToasts` has already
     * run, so a toast raised there would outlive the take it describes.
     */
    pipeline.captured.onStop = (deps) => {
      cb<[string, boolean]>(deps, 'onSessionFailure')('STT_SESSION_FAILED', true);
      cb<[string]>(deps, 'onTranscriptLine')('last words');
      cb<[number]>(deps, 'onAudioDropped')(2);
    };
    const a = start();
    cb<[string]>(a, 'onTranscriptLine')('said during the take');
    stopSession();
    expect(get(session).transcriptTail).toEqual(['said during the take']);
    expect(get(session).connection).not.toBe('offline');
    expect(get(toasts)).toEqual([]);
  });

  it('a hard pause that fails after its take ended raises nothing', async () => {
    start();
    pipeline.captured.hardPauseError = { code: 'STT_SESSION_FAILED', userMessage: 'no' };
    hardPause();
    stopSession();
    start();
    clearToasts();
    await vi.advanceTimersByTimeAsync(200);
    expect(get(toasts)).toEqual([]);
  });

  it('a resume that answers after its take was replaced leaves the new take alone', async () => {
    start();
    hardPause();
    pipeline.captured.resumeDelayMs = 150;
    pipeline.captured.resumeError = { code: 'MIC_DEVICE_LOST', userMessage: 'gone' };
    const resuming = resumeSession();
    stopSession();
    start();
    hardPause();
    const before = takeState();
    clearToasts();
    await vi.advanceTimersByTimeAsync(200);
    await resuming;
    expect(takeState()).toEqual(before);
    expect(get(toasts)).toEqual([]);
  });

  it('a resume that succeeds after its take was replaced does not unpause the new take', async () => {
    start();
    hardPause();
    pipeline.captured.resumeDelayMs = 150;
    const resuming = resumeSession();
    stopSession();
    start();
    hardPause();
    const before = takeState();
    expect(before.paused).toBe('hard');
    await vi.advanceTimersByTimeAsync(200);
    await resuming;
    expect(takeState()).toEqual(before);
  });

  it('a display probe that answers after its take was replaced under the same id says nothing', async () => {
    const display = { fingerprint: 'panel-a', name: 'Panel A' } as unknown as DisplayDescriptor;
    start({ sessionId: 'same-id', stageDisplay: display });
    await vi.advanceTimersByTimeAsync(2000);
    expect(probes).toHaveLength(1);
    const answerA = probes.shift()!;
    start({ sessionId: 'same-id', stageDisplay: display });
    answerA({ fingerprint: 'panel-b', name: 'Panel B' });
    await vi.advanceTimersByTimeAsync(0);
    expect(get(session).displayChangedTo).toBeNull();
    // The new take's own probe still reports.
    await vi.advanceTimersByTimeAsync(2000);
    probes.shift()!({ fingerprint: 'panel-b', name: 'Panel B' });
    await vi.advanceTimersByTimeAsync(0);
    expect(get(session).displayChangedTo).toBe('Panel B');
  });

  it('a retry that fails after its take was replaced reports nothing', async () => {
    start();
    pipeline.captured.resumeDelayMs = 150;
    pipeline.captured.resumeError = { code: 'MIC_DEVICE_LOST', userMessage: 'gone' };
    const retrying = retryMicrophone();
    stopSession();
    pipeline.captured.resumeError = null;
    start();
    const before = takeState();
    clearToasts();
    await vi.advanceTimersByTimeAsync(200);
    expect(await retrying).toBe(false);
    expect(takeState()).toEqual(before);
    expect(get(toasts)).toEqual([]);
  });

  it('a switch that fails after its take was replaced reports nothing', async () => {
    start();
    pipeline.captured.switchError = { code: 'MIC_DEVICE_BUSY', userMessage: 'busy' };
    const switching = switchMicrophone('mic-2', 'Mic 2');
    stopSession();
    pipeline.captured.switchError = null;
    start();
    const before = takeState();
    clearToasts();
    await vi.advanceTimersByTimeAsync(200);
    expect(await switching).toBe(false);
    expect(takeState()).toEqual(before);
    expect(get(toasts)).toEqual([]);
  });

  it('a switch with nothing to swap does not reopen a take that has ended', async () => {
    start();
    pipeline.captured.switchOpens = false;
    const switching = switchMicrophone('mic-2', 'Mic 2');
    stopSession();
    start();
    await vi.advanceTimersByTimeAsync(200);
    expect(await switching).toBe(false);
    expect(pipeline.captured.resumedBy, 'the ended take’s pipeline was reopened').not.toContain(0);
  });

  it('a retry and a microphone switch that answer after the take ended report nothing', async () => {
    start();
    pipeline.captured.resumeDelayMs = 150;
    const retrying = retryMicrophone();
    const switching = switchMicrophone('mic-2', 'Mic 2');
    stopSession();
    start();
    const before = takeState();
    clearToasts();
    await vi.advanceTimersByTimeAsync(200);
    expect(await retrying).toBe(false);
    expect(await switching).toBe(false);
    expect(takeState()).toEqual(before);
    expect(get(toasts)).toEqual([]);
  });
});
