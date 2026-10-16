/**
 * The voice pill, end to end, with only the operating system faked.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AND WHAT IT COVERS THAT UNIT TESTS DO NOT
 * ---------------------------------------------------------------------------
 * The pill's reducer has its own suite, and it passed throughout the two worst
 * defects this feature has had — because neither lived in the reducer. One was
 * a render gate on the stage (the pill was hidden until an alignment snapshot
 * arrived, i.e. until transcription had already succeeded, so it could not
 * report the failure it exists for). The other was a wiring choice in the store
 * (§28.6's five-second silence detector was fed to it as "device lost", so a
 * presenter pausing to think got a cross and "No audio").
 *
 * Both are seam defects, and a seam is only testable by running the seam. So
 * this file stands up the REAL objects — the real session store, the real
 * `VoiceSessionPipeline`, the real `MicrophoneMonitor`, the real VAD, the real
 * device manager, the real pill reducer — and fakes only what a test process
 * genuinely cannot have:
 *
 *   • `navigator.mediaDevices` — getUserMedia, enumerateDevices, devicechange;
 *   • `AudioContext` — an analyser whose samples the test dictates, which is
 *     what turns "the presenter speaks" into a real chain of level frames;
 *   • the Tauri IPC boundary and the `stt://event` channel Rust emits on.
 *
 * Everything the app then does is its own code. The assertions are made on the
 * payloads that actually reach the stage — `SessionState.voicePill`, which Live
 * hands to the embedded stage's `voicePill` prop — because that is the only
 * thing a presenter can see.
 *
 * The clock is faked, and `vi.useFakeTimers()` fakes `performance.now()` too —
 * which matters, because every window in the pill (stale frames, the unheard
 * bound, the confirm hold) is measured on that clock and against the
 * `generatedAtMs` the monitor stamps from it. Advancing time therefore advances
 * the audio clock and the decision clock together, exactly as production does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STT_SAMPLE_RATE_HZ } from '../../src/control/services/stt/local';
import type { CompiledScript, StageVoicePillPayload } from '../../src/shared/contracts';

/* ---------------------------------------------------------------------------
 * The operating system, faked
 * ------------------------------------------------------------------------- */

/** What the microphone is "hearing" right now. 0 is a silent room. */
let amplitude = 0;
/** Set when the fake device refuses to open, to reproduce contention. */
let refusals = 0;
/**
 * Tracks this TEST's captures, and nothing else's.
 *
 * Per-test bookkeeping rather than running counters, because a take's teardown
 * outlives the test that started it: `stopInternals` does not await
 * `pipeline.stop()`, and `vi.useRealTimers()` in the teardown discards whatever
 * fake timers that teardown was still waiting on — so the stream can be
 * released after the next test has already begun. Against a shared counter that
 * reads as "the new take already has the device", and every timing assertion
 * after it drifts. A set that is replaced per test simply ignores the ghost.
 */
let openTracks = new Set<FakeTrack>();
let capturesOpened = 0;

interface FakeTrack {
  kind: string;
  label: string;
  readyState: 'live' | 'ended';
  stop(): void;
  addEventListener(): void;
  removeEventListener(): void;
}

function fakeStream(): { getAudioTracks(): FakeTrack[]; getTracks(): FakeTrack[] } {
  capturesOpened += 1;
  const owner = openTracks;
  const track: FakeTrack = {
    kind: 'audio',
    label: 'Fake Mic',
    readyState: 'live',
    stop() {
      owner.delete(track);
      track.readyState = 'ended';
    },
    addEventListener() {},
    removeEventListener() {},
  };
  openTracks.add(track);
  const tracks = [track];
  return { getAudioTracks: () => tracks, getTracks: () => tracks };
}

/** Devices the fake enumerator reports; a test can unplug one. */
let devices = [
  { deviceId: 'mic-usb', kind: 'audioinput', label: 'USB Mic', groupId: 'g1' },
  { deviceId: 'default', kind: 'audioinput', label: 'Built-in', groupId: 'g2' },
];

const deviceBus = new EventTarget();
const mediaDevices = {
  getUserMedia: vi.fn(async () => {
    if (refusals > 0) {
      refusals -= 1;
      // The macOS handover failure, verbatim: the device exists and is still
      // being released by whoever had it.
      throw Object.assign(new Error('Could not start audio source'), {
        name: 'NotReadableError',
      });
    }
    return fakeStream();
  }),
  enumerateDevices: vi.fn(async () => devices),
  addEventListener: (name: string, fn: EventListener) => deviceBus.addEventListener(name, fn),
  removeEventListener: (name: string, fn: EventListener) =>
    deviceBus.removeEventListener(name, fn),
};

/**
 * An AudioContext whose analyser reports whatever `amplitude` says.
 *
 * This is the seam that makes the test real: the samples go through the actual
 * `computeFrameStats` and the actual `LocalVad`, so "the presenter is speaking"
 * is a property of the audio, not a flag handed to the code under test.
 */
class FakeAudioContext {
  state: 'running' | 'suspended' | 'closed' = 'running';
  sampleRate = STT_SAMPLE_RATE_HZ;
  destination = {};
  createMediaStreamSource(): { connect(): void; disconnect(): void } {
    return { connect() {}, disconnect() {} };
  }
  createAnalyser(): unknown {
    return {
      fftSize: 2048,
      connect() {},
      disconnect() {},
      getFloatTimeDomainData(buffer: Float32Array) {
        for (let i = 0; i < buffer.length; i += 1) {
          // A tone rather than a constant: an RMS and a peak that differ is
          // what the level pipeline actually sees.
          buffer[i] = amplitude * Math.sin((i / buffer.length) * Math.PI * 12);
        }
      },
    };
  }
  createGain(): unknown {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  createScriptProcessor(): unknown {
    return { onaudioprocess: null, connect() {}, disconnect() {} };
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
}

/* ---------------------------------------------------------------------------
 * The Tauri boundary, faked
 * ------------------------------------------------------------------------- */

/** Handlers registered through `listen`, by event name. */
const listeners = new Map<string, Array<(event: { payload: unknown }) => void>>();

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const list = listeners.get(name) ?? [];
    list.push(handler);
    listeners.set(name, list);
    return () => {
      const current = listeners.get(name) ?? [];
      listeners.set(
        name,
        current.filter((fn) => fn !== handler),
      );
    };
  }),
}));

/**
 * Rust emitting a transcription frame.
 *
 * Waits for the pipeline to be listening first, and fails loudly if it never
 * is. The subscription is set up behind `await import('@tauri-apps/api/event')`
 * — a real module load, not a timer — so a test that emitted on a fixed
 * schedule would sometimes fire into an empty channel and then assert about a
 * pill that had simply never been told anything. That is a flaky test dressed
 * as a product bug; this makes the wait explicit and the absence an error.
 */
async function emitStt(payload: Record<string, unknown>): Promise<void> {
  await until(
    () => (listeners.get('stt://event') ?? []).length > 0,
    'the take to subscribe to the transcription channel',
  );
  const handlers = listeners.get('stt://event') ?? [];
  if (handlers.length === 0) {
    throw new Error('nothing is listening on stt://event — the take never opened its transport');
  }
  for (const handler of handlers) handler({ payload });
}

const stage = vi.hoisted(() => ({
  listDisplays: vi.fn(async () => [{ fingerprint: 'display-0' }]),
}));

const records = vi.hoisted(() => ({
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
}));

vi.mock('../../src/control/services/stage', () => stage);
vi.mock('../../src/control/services/session-records', () => records);
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
vi.mock('../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});
vi.mock('../../src/control/services/alignment', async (orig) => {
  const actual = await orig<typeof import('../../src/control/services/alignment')>();
  return { ...actual, subscribeAlignmentSnapshots: () => () => {} };
});

const { setInvokeForTesting } = await import('../../src/control/services/ipc');
const { clearSession, startLiveSession, restartParagraph, session } = await import(
  '../../src/control/stores/session'
);

/* ---------------------------------------------------------------------------
 * Harness
 * ------------------------------------------------------------------------- */

/**
 * Every pill payload handed to the stage, in order — recorded off the session
 * store, whose `voicePill` is the embedded stage's prop. Only NEW payloads
 * count: every other session update notifies subscribers too.
 */
let published: StageVoicePillPayload[] = [];
let stopRecording: (() => void) | null = null;

function pills(): StageVoicePillPayload[] {
  return published;
}

function latest(): StageVoicePillPayload {
  const pill = pills().at(-1);
  if (!pill) throw new Error('the stage was never told anything about the microphone');
  return pill;
}

function compiledStub(): CompiledScript {
  return {
    sourceHash: 'hash-abc',
    spokenTokens: [
      { index: 0, blockId: 'b-1', sentenceId: 's-1', surface: 'Hello', normalized: 'hello' },
      { index: 1, blockId: 'b-1', sentenceId: 's-1', surface: 'there', normalized: 'there' },
    ],
    sentences: [
      { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 2, text: 'Hello there.' },
    ],
    navigationTargets: [],
    literalCommandRanges: [],
  } as unknown as CompiledScript;
}

function start(overrides: { micDeviceId?: string } = {}): void {
  startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'voice',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: 'session-uuid-1',
    compiled: compiledStub(),
    sessionGeneration: 7,
    ...overrides,
  });
}

/**
 * Let the take actually come up.
 *
 * `pipeline.start()` is a chain of awaits — the §29.2 gate, the permission
 * query, the socket subscription, `getUserMedia` — so time has to be advanced
 * with the microtask queue drained in between, which is what
 * `advanceTimersByTimeAsync` does.
 */
async function run(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/**
 * Advance session time until `predicate` holds, then stop.
 *
 * Every wait in this file is condition-based rather than duration-based, and
 * that is not fussiness. The chain under test contains real module loads
 * (`await import('@tauri-apps/api/event')`) and real promise resolution, which
 * fake timers do not schedule — so "advance a second and assert" passes on an
 * idle machine and fails on a loaded one, which is the definition of a test
 * nobody can trust. Bounded, and it throws with the thing it was waiting for.
 */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 600 && !predicate(); i += 1) {
    /*
     * A REAL turn of the event loop as well as a fake one.
     *
     * The code under test resolves `await import('@tauri-apps/api/event')` on
     * the way to `getUserMedia`, and a module load completes on the macrotask
     * queue — which fake timers do not drive. Advancing fake time alone can
     * therefore spin 120 times while the pipeline sits one real tick from
     * continuing. Under a loaded parallel suite, advancing fake time before
     * giving imports and promises their turn can manufacture thirty seconds of
     * "no microphone" during a real sub-second module load. That falsely trips
     * the pill's stale-input detector. Drain several real turns FIRST, then
     * advance the product clock only if the condition still needs a timer.
     * `process.nextTick` is not faked by Vitest, so this is the yield that
     * always lands.
     */
    for (let turn = 0; turn < 5 && !predicate(); turn += 1) {
      await new Promise((resolve) => {
        process.nextTick(resolve);
      });
    }
    if (!predicate()) await vi.advanceTimersByTimeAsync(50);
  }
  if (!predicate()) throw new Error(`timed out waiting for: ${what}`);
}

/** Wait for the pill to reach a reading, so the assertion is about the app. */
async function untilReading(reading: string): Promise<void> {
  await until(
    () => pills().length > 0 && latest().reading === reading,
    `the pill to read "${reading}" (last was "${pills().at(-1)?.reading ?? 'nothing'}")`,
  );
}

/**
 * Wait for the take to actually hold the microphone.
 *
 * Same reasoning as `emitStt`: `getUserMedia` sits behind a chain that includes
 * a real module load, so "advance a second and assume" is a coin flip under a
 * loaded test runner. Bounded, and it throws rather than letting a take that
 * never opened the device pass as one that did.
 */
async function untilCaptureOpen(): Promise<void> {
  await until(() => openTracks.size > 0, 'the take to open the microphone');
}

/** Speak, or stop speaking, for `ms` of session time. */
async function speak(ms: number): Promise<void> {
  amplitude = 0.35;
  await run(ms);
}

async function silence(ms: number): Promise<void> {
  amplitude = 0;
  await run(ms);
}

beforeEach(async () => {
  /*
   * Load the event module before the clock is faked.
   *
   * Both the pipeline and the store reach it through `await import(...)`, and
   * an uncached dynamic import needs a macrotask turn to settle. Warming the
   * registry here means every later import resolves in a microtask, which is
   * what makes the fake clock a complete description of the test's time.
   */
  await import('@tauri-apps/api/event');
  vi.useFakeTimers();
  published = [];
  stopRecording = session.subscribe((s) => {
    if (s.voicePill !== null && s.voicePill !== published.at(-1)) published.push(s.voicePill);
  });
  listeners.clear();
  amplitude = 0;
  refusals = 0;
  openTracks = new Set();
  capturesOpened = 0;
  devices = [
    { deviceId: 'mic-usb', kind: 'audioinput', label: 'USB Mic', groupId: 'g1' },
    { deviceId: 'default', kind: 'audioinput', label: 'Built-in', groupId: 'g2' },
  ];
  mediaDevices.getUserMedia.mockClear();
  (globalThis as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  /*
   * `navigator` is a getter-only global in node, so it is redefined rather than
   * assigned. §28.1: no `permissions` entry, which is the WKWebView answer
   * ('unsupported') and therefore the path where `getUserMedia` resolves
   * permission implicitly — the one production actually takes on macOS.
   */
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { mediaDevices },
  });
  setInvokeForTesting(async (command) => {
    if (command === 'start_transcription') return 1 as never;
    return undefined as never;
  });
});

afterEach(async () => {
  clearSession();
  /*
   * Wait for the previous take to genuinely let go before the next one starts.
   *
   * `stopInternals` does not await `pipeline.stop()`, so its teardown — closing
   * the session, stopping the monitor, releasing the stream — runs on into
   * whatever comes next. In production that is harmless; in a test file it
   * means take N+1 acquires its device behind take N's teardown and every
   * timing-sensitive assertion drifts. Tolerant rather than throwing: a
   * teardown that will not finish is not this test's failure to report.
   */
  for (let i = 0; i < 200 && openTracks.size > 0; i += 1) {
    await vi.advanceTimersByTimeAsync(50);
    await new Promise((resolve) => {
      process.nextTick(resolve);
    });
  }
  await vi.runOnlyPendingTimersAsync();
  stopRecording?.();
  stopRecording = null;
  setInvokeForTesting(null);
  vi.useRealTimers();
});

/* ---------------------------------------------------------------------------
 * The take, from the presenter's side of the glass
 * ------------------------------------------------------------------------- */

describe('a healthy take', () => {
  it('shows the pill from the start, moves with the voice, and ticks when words come back', async () => {
    start();
    // Before the device is even open, the presenter can see the app listening.
    await run(150);
    expect(latest().reading).toBe('listening');
    expect(latest().visible).toBe(true);

    // The capture comes up and the waveform starts moving with the voice.
    await untilCaptureOpen();
    await speak(1000);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    const speaking = latest();
    expect(speaking.reading).toBe('listening');
    expect(speaking.levels.length).toBeGreaterThan(5);
    expect(speaking.levels.some((level) => level > 0.1)).toBe(true);

    // Rust returns a partial: the whole chain is proven, and the pill says so.
    await emitStt({ kind: 'partial', generation: 1, itemId: 'i-1', text: 'hello there' });
    await untilReading('confirmed');
    expect(latest().label).toBe('Hearing you');
    expect(latest().visible).toBe(true);

    /*
     * ...and then the PILL stays and the TICK settles, which is the point.
     *
     * The pill used to fade a couple of seconds after the tick. That retired
     * the waveform along with the confirmation, and the waveform is the only
     * thing on the glass that says audio is arriving NOW — a presenter ten
     * minutes into a take has no other way to ask, and "you were heard at
     * 00:04" is not an answer about 00:10.
     *
     * The mark is the opposite case: a filled tick lit for the whole take is
     * reporting an event nobody can act on any more. It settles into the steady
     * dot, which is still a claim ("we have heard you") and is not an
     * announcement.
     */
    await run(3000);
    expect(latest().reading).toBe('steady');
    expect(latest().visible).toBe(true);

    // And the trace is still LIVE — it follows the room down into silence and
    // back up, rather than being a frozen picture of the level that proved the
    // chain three seconds ago.
    await silence(1500);
    expect(latest().visible).toBe(true);
    expect(latest().levels.at(-1)).toBeLessThan(0.05);
    await speak(1500);
    expect(latest().visible).toBe(true);
    expect(latest().levels.at(-1)).toBeGreaterThan(0.1);
  });

  it('never shows a fault while the presenter simply thinks', async () => {
    /*
     * The defect that started all of this, in its most expensive form. §28.6's
     * `SilentInputDetector` raises MIC_NO_SIGNAL after five seconds without
     * signal, and the store turns that into `inputDeviceLost` — correctly, for
     * the status bar. Wired to the pill it put a cross and "No audio" on the
     * stage of a take whose microphone was working perfectly, every time the
     * presenter paused to collect a thought.
     *
     * This asserts the divergence directly: the session-level flag rises, and
     * the pill does not budge.
     */
    start();
    await untilCaptureOpen();
    await speak(1200);
    await emitStt({ kind: 'partial', generation: 1, itemId: 'i-1', text: 'hello' });
    await untilReading('confirmed');

    await silence(30_000);

    let inputDeviceLost = false;
    const stop = session.subscribe((s) => {
      inputDeviceLost = s.inputDeviceLost;
    });
    stop();
    expect(inputDeviceLost, 'the §28.6 detector should have fired').toBe(true);
    expect(latest().reading, 'but silence is not a fault').toBe('steady');
    expect(pills().every((p) => p.reading !== 'fault')).toBe(true);
  });
});

describe('a microphone that is still being released (the macOS handover)', () => {
  it('retries, comes up, and never tells the presenter anything went wrong', async () => {
    /*
     * The intermittency: macOS frees an input asynchronously, so the take's
     * `getUserMedia` — issued right after the Preflight meter let go — is
     * rejected rather than queued if it lands inside CoreAudio's teardown
     * window. Without the retry this take reported "Voice tracking is
     * unavailable" and the script never moved; with it, the presenter sees a
     * pill that says "listening" for a moment longer and then works.
     */
    refusals = 2;
    start();
    await run(150);
    expect(latest().reading).toBe('listening');

    // 250 ms + 500 ms of backoff, then the device opens.
    amplitude = 0.35;
    await untilCaptureOpen();
    await speak(1000);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(3);
    expect(openTracks.size).toBe(1);

    await emitStt({ kind: 'partial', generation: 1, itemId: 'i-1', text: 'testing one two' });
    await untilReading('confirmed');
    // Nothing in the whole take ever accused the microphone.
    expect(pills().every((p) => p.reading !== 'fault')).toBe(true);
  });

  it('gives up honestly when the device never frees up', async () => {
    refusals = 99;
    start();
    // Four attempts — 250 + 500 + 1000 ms of backoff — and then it gives up.
    await until(
      () => mediaDevices.getUserMedia.mock.calls.length === 4,
      'the four acquisition attempts',
    );
    await untilReading('fault');
    expect(latest().label).toBe('No audio');
    expect(latest().visible).toBe(true);
  });
});

describe('the failure the pill exists for', () => {
  it('says so when the presenter is speaking and nothing comes back', async () => {
    /*
     * The socket is up, the microphone is up, the waveform moves — and the
     * recogniser returns nothing. Before the pill this was invisible: the
     * script simply did not follow, and the only place it was written down was
     * a word count nobody looks at until afterwards.
     */
    start();
    await untilCaptureOpen();
    // The VAD calibrates its noise floor over the first two seconds (A.6), so
    // the room is quiet first — which is also what a take looks like: the stage
    // goes up, and then the presenter starts.
    await silence(2500);
    await speak(1000);
    expect(latest().reading).toBe('listening');
    await speak(5000);
    await untilReading('fault');
    expect(latest().label).toBe('Not hearing you');
    expect(latest().visible).toBe(true);
  });

  it('clears the moment words do come back', async () => {
    start();
    await untilCaptureOpen();
    await silence(2500);
    await speak(6000);
    await untilReading('fault');
    await emitStt({ kind: 'partial', generation: 1, itemId: 'i-1', text: 'there we go' });
    await untilReading('confirmed');
    // The recovery gets its own hold, so the presenter actually sees it.
    expect(latest().visible).toBe(true);
  });

  it('reports a transport that has gone offline', async () => {
    start();
    await untilCaptureOpen();
    await speak(1000);
    await emitStt({ kind: 'partial', generation: 1, itemId: 'i-1', text: 'hello' });
    await untilReading('confirmed');

    /*
     * The socket closes while the microphone keeps working — the case worth
     * reporting separately. (A FATAL provider failure also tears the capture
     * down, and then "No audio" is the truer of the two readings; this test is
     * about the one where audio is fine and nothing can be transcribed.)
     */
    await emitStt({ kind: 'transport', generation: 1, state: 'closed' });
    await untilReading('fault');
    expect(latest().label).toBe('Not connected');
    // ...and the audio is demonstrably still flowing, so this is not the
    // stale-capture fault wearing the wrong label.
    expect(latest().levels.length).toBeGreaterThan(5);
  });
});

describe('the device going away', () => {
  it('crosses the pill when the selected input is unplugged', async () => {
    // Driven through the real `MicrophoneDeviceManager`: the device list
    // changes and `devicechange` fires, exactly as WKWebView delivers it.
    start({ micDeviceId: 'mic-usb' });
    await untilCaptureOpen();
    await speak(1000);
    await emitStt({ kind: 'partial', generation: 1, itemId: 'i-1', text: 'hello' });
    await untilReading('confirmed');

    devices = [{ deviceId: 'default', kind: 'audioinput', label: 'Built-in', groupId: 'g2' }];
    deviceBus.dispatchEvent(new Event('devicechange'));
    await untilReading('fault');
    expect(latest().label).toBe('No audio');
    expect(latest().visible).toBe(true);
  });
});

describe('take boundaries', () => {
  it('makes a retake prove itself again', async () => {
    start();
    await untilCaptureOpen();
    await speak(1000);
    await emitStt({ kind: 'partial', generation: 1, itemId: 'i-1', text: 'hello' });
    await untilReading('confirmed');
    await run(3000);
    expect(latest().reading, 'a proven take stays proven').toBe('steady');
    expect(latest().visible, 'and stays on screen — the audio is still arriving').toBe(true);

    restartParagraph();
    await run(150);
    // §36.3: a new pass. The last pass being heard says nothing about this one.
    expect(latest().reading).toBe('listening');
    expect(latest().visible).toBe(true);
  });

  it('stops talking to the stage, and releases the device, when the take ends', async () => {
    start();
    await untilCaptureOpen();
    await speak(1000);
    expect(openTracks.size).toBe(1);
    clearSession();
    await until(() => openTracks.size === 0, 'the take to release the microphone');
    const count = pills().length;
    await run(2000);
    expect(pills(), 'a finished take must stop talking to the stage').toHaveLength(count);
  });
});
