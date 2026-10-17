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
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
}));

/** The pipeline is stubbed so the test can drive its callbacks directly. */
const pipeline = vi.hoisted(() => {
  const captured: {
    deps: Record<string, (...args: never[]) => unknown> | null;
    /** Makes the NEXT pipeline's start reject, as a busy microphone would. */
    failNextStart: boolean;
    /** What that start rejects with; a busy microphone when left null. */
    startError: unknown;
    /** Makes every resume reject with this, as a refused restart would. */
    resumeError: unknown;
  } = { deps: null, failNextStart: false, startError: null, resumeError: null };
  class FakePipeline {
    private readonly fails: boolean;
    private readonly error: unknown;
    constructor(deps: Record<string, (...args: never[]) => unknown>) {
      captured.deps = deps;
      this.fails = captured.failNextStart;
      this.error = captured.startError ?? new Error('MIC_DEVICE_LOST');
    }
    async start(): Promise<void> {
      if (this.fails) {
        // Long enough that the replacement take is already running, which is
        // the whole point: the retry can spend 1.75 s before giving up.
        await new Promise((resolve) => setTimeout(resolve, 150));
        throw this.error;
      }
    }
    async stop(): Promise<void> {}
    startListening(): void {}
    softPause(): void {}
    async hardPause(): Promise<void> {}
    async resume(): Promise<void> {
      const error = captured.resumeError;
      if (error === null) return;
      // A refused resume re-ran the whole start, so it answers late too.
      await new Promise((resolve) => setTimeout(resolve, 150));
      throw error;
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
const {
  autoScrollLive,
  clearSession,
  hardPause,
  pauseListening,
  resumeSession,
  session,
  startLiveSession,
  stopSession,
  toggleAutoScroll,
  togglePlayPause,
} = await import('../../../src/control/stores/session');
const { get } = await import('svelte/store');
const { toasts } = await import('../../../src/control/stores/toasts');

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
  pipeline.captured.failNextStart = false;
  pipeline.captured.startError = null;
  pipeline.captured.resumeError = null;
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
    // A microphone failure is not a missing model: the summary keeps its
    // microphone advice for exactly this take.
    expect(get(session).voiceFollowingAvailable).toBe(true);
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

/** The shape `ipcInvoke` rejects with: an AppError, not an Error. */
function refusal(code: string): unknown {
  return { code, userMessage: 'The speech model could not be used.' };
}

async function refusedTake(code: string): Promise<void> {
  pipeline.captured.failNextStart = true;
  pipeline.captured.startError = refusal(code);
  start();
  pipeline.captured.failNextStart = false;
  await vi.advanceTimersByTimeAsync(200);
}

/**
 * A refused speech model is not a microphone fault (#286).
 *
 * `startTranscription()` runs AFTER the microphone opens, so a take started
 * with no usable model had a working input and no recogniser. It used to come
 * out of the same branch as a dead microphone: "Mic lost" in the status bar
 * while it ran, and "Nothing was transcribed — test or change the microphone"
 * when it ended. The take records the refusal itself, so both can say what
 * actually happened whichever path started the take.
 */
describe('a take whose speech model was refused', () => {
  for (const code of [
    'STT_MODEL_NOT_INSTALLED',
    'STT_MODEL_MISSING',
    'STT_MODEL_LOAD_FAILED',
    'STT_MODEL_DAMAGED',
  ]) {
    it(`records ${code} as no voice following, not a lost microphone`, async () => {
      await refusedTake(code);
      const s = get(session);
      expect(s.voiceFollowingAvailable).toBe(false);
      // No capture runs, so neither of these may claim otherwise...
      expect(s.micState).toBe('disconnected');
      expect(s.connection).toBe('offline');
      // ...but the input did nothing wrong, so no picker is offered for it.
      expect(s.inputDeviceLost).toBe(false);

      // Long enough to clear the five-second "too short to judge" bar, which is
      // where the summary used to fall into its microphone advice.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(stopSession().voiceFollowingAvailable).toBe(false);
    });
  }

  it('does not let a stray connection from before the refusal vouch for this take', async () => {
    /*
     * The pipeline accepts STT frames before it knows its own transport
     * generation, so a `connected` from a take that was still starting when it
     * was replaced can arrive while this one waits on its recogniser. This take
     * then had its start refused, so no transport of its own ever existed —
     * and the summary must not report one.
     */
    pipeline.captured.failNextStart = true;
    pipeline.captured.startError = refusal('STT_MODEL_NOT_INSTALLED');
    start();
    pipeline.captured.failNextStart = false;
    (deps().onConnectionState as unknown as (state: string) => void)('connected');
    await vi.advanceTimersByTimeAsync(200);
    expect(get(session).voiceFollowingAvailable).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(stopSession().voiceFollowingAvailable).toBe(false);
  });

  it('records nothing for a start the app itself abandoned', async () => {
    // `SESSION_STOPPED` is this app tearing the take down mid-start, not a
    // refusal — the guard that keeps it out of the toast keeps it out of here.
    await refusedTake('SESSION_STOPPED');
    const s = get(session);
    expect(s.voiceFollowingAvailable).toBe(true);
    expect(s.connection).not.toBe('offline');
  });

  it('does not treat other model codes as a refused take', async () => {
    // A failed DOWNLOAD shares the prefix and describes a Settings action.
    await refusedTake('STT_MODEL_DOWNLOAD_FAILED');
    expect(get(session).voiceFollowingAvailable).toBe(true);
  });

  it('keeps a microphone failure a microphone failure on the summary', async () => {
    await refusedTake('MIC_DEVICE_LOST');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(stopSession().voiceFollowingAvailable).toBe(true);
  });

  it('reports a take whose recogniser started as having one, even if it heard nothing', async () => {
    start();
    (deps().onConnectionState as unknown as (state: string) => void)('connected');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(stopSession().voiceFollowingAvailable).toBe(true);
  });

  it('does not let a replaced take mark its replacement as having no model', async () => {
    pipeline.captured.failNextStart = true;
    pipeline.captured.startError = refusal('STT_MODEL_NOT_INSTALLED');
    start();
    pipeline.captured.failNextStart = false;
    pipeline.captured.startError = null;
    start();
    await vi.advanceTimersByTimeAsync(200);
    expect(get(session).voiceFollowingAvailable, 'take A may not fault take B').toBe(true);
  });

  it('starts every take with voice following assumed, not inherited', async () => {
    await refusedTake('STT_MODEL_NOT_INSTALLED');
    expect(get(session).voiceFollowingAvailable).toBe(false);
    start();
    expect(get(session).voiceFollowingAvailable).toBe(true);
  });

  it('clears the refusal once a recogniser actually connects', async () => {
    // A model installed mid-take and a resume that restarts the recogniser:
    // the connection is the evidence, and the take now does follow voice.
    await refusedTake('STT_MODEL_NOT_INSTALLED');
    (deps().onConnectionState as unknown as (state: string) => void)('connected');
    expect(get(session).voiceFollowingAvailable).toBe(true);
  });

  it('does not take a resume that merely resolved as proof the model loaded', async () => {
    // `resume()` returns at once when nothing was paused, having restarted
    // nothing. Only a recogniser that connects is evidence.
    await refusedTake('STT_MODEL_NOT_INSTALLED');
    resumeSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(get(session).voiceFollowingAvailable).toBe(false);
  });

  it('does not let a replaced take’s refused resume reach the take after it', async () => {
    /*
     * After a hard pause a resume re-runs the whole start, so it can still be
     * in flight when the take is replaced. Its refusal used to pause the NEW
     * take, mark its microphone lost and toast about a failure it never had.
     */
    start();
    pipeline.captured.resumeError = refusal('STT_MODEL_MISSING');
    resumeSession();
    pipeline.captured.resumeError = null;
    start();
    const resumeToasts = () =>
      get(toasts).filter((toast) => toast.message.startsWith('Could not resume')).length;
    const toastsBefore = resumeToasts();

    await vi.advanceTimersByTimeAsync(200);
    const s = get(session);
    expect(s.voiceFollowingAvailable, 'take A may not fault take B').toBe(true);
    expect(s.paused).toBe('none');
    expect(s.micState).toBe('live');
    expect(s.connection).not.toBe('offline');
    expect(resumeToasts()).toBe(toastsBefore);
  });

  it('records a refusal that arrives through a resume', async () => {
    // `resume()` re-runs `start()` after a hard pause, so it meets the same
    // refusal by a second road.
    start();
    pipeline.captured.resumeError = refusal('STT_MODEL_MISSING');
    resumeSession();
    await vi.advanceTimersByTimeAsync(200);
    expect(get(session).voiceFollowingAvailable).toBe(false);
    expect(get(session).inputDeviceLost).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(stopSession().voiceFollowingAvailable).toBe(false);
  });

  it('does not tell a take that followed for a while that it never had a recogniser', async () => {
    /*
     * Connected, heard, then refused on a resume. The status bar says voice is
     * unavailable NOW, which is true; the summary must not say the take never
     * followed, which is not — it reports on what was heard instead.
     */
    start();
    (deps().onConnectionState as unknown as (state: string) => void)('connected');
    pipeline.captured.resumeError = refusal('STT_MODEL_LOAD_FAILED');
    resumeSession();
    await vi.advanceTimersByTimeAsync(200);
    expect(get(session).voiceFollowingAvailable).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(stopSession().voiceFollowingAvailable).toBe(true);
  });
});

/**
 * A resume whose voice cannot come back still un-pauses the take (#279).
 *
 * The glass offers auto-scroll to a presenter whose recogniser never started,
 * and that roll only runs while nothing is paused. A failed resume used to keep
 * the pause, so Space could stop the script and never start it again — the
 * take was over in everything but name. Released is not recovered, though: the
 * microphone stays disconnected and the failure is still said out loud.
 */
describe('a take whose voice cannot be resumed', () => {
  const resumeToasts = () =>
    get(toasts).filter((toast) => toast.message.startsWith('Could not resume voice following'))
      .length;

  for (const code of ['STT_MODEL_NOT_INSTALLED', 'MIC_PERMISSION_DENIED']) {
    it(`lets Space bring auto-scroll back after ${code} refuses the resume`, async () => {
      await refusedTake(code);
      toggleAutoScroll();
      expect(get(autoScrollLive).running).toBe(true);

      togglePlayPause();
      expect(get(session).paused).toBe('listening');
      expect(get(autoScrollLive).running, 'a pause stops the roll').toBe(false);

      const toastsBefore = resumeToasts();
      pipeline.captured.resumeError = refusal(code);
      togglePlayPause();
      // The resume re-runs the whole start, and the take holds until it answers.
      expect(get(autoScrollLive).running).toBe(false);
      await vi.advanceTimersByTimeAsync(200);

      const s = get(session);
      expect(s.paused).toBe('none');
      expect(get(autoScrollLive).running, 'the roll picks up where it stopped').toBe(true);
      expect(s.micState).toBe('disconnected');
      expect(s.connection).toBe('offline');
      expect(s.voiceFollow, 'the transport still owns the follow pause').toBe(false);
      expect(resumeToasts()).toBe(toastsBefore + 1);

      // Not a one-off: the next Space pair stops the roll and starts it again.
      togglePlayPause();
      expect(get(autoScrollLive).running).toBe(false);
      togglePlayPause();
      await vi.advanceTimersByTimeAsync(200);
      expect(get(autoScrollLive).running).toBe(true);
      expect(get(session).micState).toBe('disconnected');
    });
  }

  it('releases a hard pause whose microphone cannot come back', async () => {
    start();
    hardPause();
    expect(get(session).micState).toBe('muted');

    pipeline.captured.resumeError = refusal('MIC_PERMISSION_DENIED');
    togglePlayPause();
    await vi.advanceTimersByTimeAsync(200);

    const s = get(session);
    expect(s.paused).toBe('none');
    // 'muted' was a choice; failing to undo it is a fault.
    expect(s.micState).toBe('disconnected');
    expect(s.connection).toBe('offline');
    // Nothing rolls until it is asked to, and then it rolls at once.
    expect(get(autoScrollLive).running).toBe(false);
    toggleAutoScroll();
    expect(get(autoScrollLive).running).toBe(true);
  });

  it('comes back for real once the microphone can', async () => {
    // Released is still recoverable: the next resume that works says so.
    start();
    hardPause();
    pipeline.captured.resumeError = refusal('MIC_PERMISSION_DENIED');
    togglePlayPause();
    await vi.advanceTimersByTimeAsync(200);
    expect(get(session).micState).toBe('disconnected');

    pipeline.captured.resumeError = null;
    const toastsBefore = resumeToasts();
    togglePlayPause();
    togglePlayPause();
    await vi.advanceTimersByTimeAsync(0);
    const s = get(session);
    expect(s.paused).toBe('none');
    expect(s.micState).toBe('live');
    expect(s.connection).toBe('connected');
    expect(resumeToasts()).toBe(toastsBefore);
  });

  it('keeps a pause made while the refused resume was still trying', async () => {
    /*
     * The retry re-runs the whole start, which can take seconds. A hard pause
     * from the menu meanwhile is the presenter's latest word, and the late
     * refusal must not release it and set the script rolling again.
     */
    await refusedTake('MIC_PERMISSION_DENIED');
    toggleAutoScroll();
    togglePlayPause();
    pipeline.captured.resumeError = refusal('MIC_PERMISSION_DENIED');
    togglePlayPause();
    hardPause();
    const toastsBefore = resumeToasts();

    await vi.advanceTimersByTimeAsync(200);
    expect(get(session).paused).toBe('hard');
    expect(get(autoScrollLive).running, 'the roll stays stopped').toBe(false);
    // The failure is still a fact, and still said.
    expect(get(session).micState).toBe('disconnected');
    expect(resumeToasts()).toBe(toastsBefore + 1);
  });

  it('does not un-pause the take after it when a replaced take’s resume is refused', async () => {
    // The release is a new write a stale resume could make, so the
    // replacement guard has to cover it too.
    start();
    pipeline.captured.resumeError = refusal('MIC_PERMISSION_DENIED');
    resumeSession();
    pipeline.captured.resumeError = null;
    start();
    pauseListening();
    const toastsBefore = resumeToasts();

    await vi.advanceTimersByTimeAsync(200);
    const s = get(session);
    expect(s.paused, 'take A may not release take B').toBe('listening');
    expect(s.micState).not.toBe('disconnected');
    expect(s.connection).not.toBe('offline');
    expect(resumeToasts()).toBe(toastsBefore);
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
