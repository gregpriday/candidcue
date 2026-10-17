/**
 * A take stopped, paused or replaced while its microphone is still opening
 * (#289).
 *
 * `start()` used to read its lifecycle token after its first three awaits, so
 * a stop that landed in the script save, the compile or the permission query
 * was invisible to every check after it: the start went on to open the
 * microphone, the level meter, the PCM tap and a recogniser session on a take
 * that had already ended, and nothing was left to close them. The macOS
 * microphone indicator stayed on after the presenter had stopped. A switch had
 * no check at all, and the acquisition itself published its stream before
 * anyone could ask whether it was still wanted.
 *
 * Driven through the real `VoiceSessionPipeline`, the real retry loop in
 * `requestMicrophoneAccess` and the real `MicrophoneMonitor`. Only the edges
 * are doubles, and each can be held at its FIRST call until the test lets it
 * go: the §29.2 gate, the permission query, the STT subscription,
 * `getUserMedia` (and its busy backoff), the analyser graph, the PCM tap and
 * the recogniser load. The doubles finish late the way the real ones do — a
 * graph or a tap whose setup completes after a stop is LIVE, which is the
 * hazard, so a forgiving mock cannot hide a leak — and the recogniser double
 * holds one session that a start replaces, as Rust's does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttFrame } from '../../../src/control/services/stt/local';

interface FakeTrack {
  readyState: 'live' | 'ended';
  stop(): void;
}

interface FakeStream {
  /** The `deviceId` it was asked for, or undefined for the system default. */
  device: string | undefined;
  track: FakeTrack;
  getTracks(): FakeTrack[];
  getAudioTracks(): FakeTrack[];
}

interface FakeTap {
  active: boolean;
  onFrame(samples: Float32Array): void;
}

interface FakeListener {
  live: boolean;
  handler(event: { payload: SttFrame }): void;
}

const env = vi.hoisted(() => {
  const state = {
    /** Boundaries whose FIRST call is held; each is cleared once it is. */
    holds: new Set<string>(),
    held: new Map<string, { release: () => void; fail: (err: unknown) => void }>(),
    /** `getUserMedia` rejects as busy this many more times. */
    busy: 0,
    /** The next `getUserMedia` rejects with this. */
    gumError: null as unknown,
    gumCalls: 0,
    streams: [] as FakeStream[],
    graphs: [] as Array<{ closed: boolean }>,
    taps: [] as FakeTap[],
    listeners: [] as FakeListener[],
    watchers: 0,
    /** The pipeline's timer seam: the busy backoff waits on these. */
    timers: [] as Array<() => void>,
    loadCalls: 0,
    nextGeneration: 1,
    opened: [] as number[],
    closed: [] as number[],
    /** Rust holds ONE session, and a start replaces it. */
    current: null as number | null,
    pushed: [] as Array<{ generation: number; chunk: string }>,
  };
  function gate(at: string): Promise<void> {
    if (!state.holds.has(at)) return Promise.resolve();
    state.holds.delete(at);
    return new Promise<void>((release, fail) => {
      state.held.set(at, { release, fail });
    });
  }
  return { state, gate };
});

vi.mock('../../../src/control/services/ipc', async (original) => ({
  ...(await original<typeof import('../../../src/control/services/ipc')>()),
  // Inside Tauri, so the STT subscription is a real await to race.
  isTauriRuntime: () => true,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_event: string, handler: (event: { payload: SttFrame }) => void) => {
    // Registered when asked for, as Tauri's is; the cleanup handle arrives later.
    const listener = { live: true, handler };
    env.state.listeners.push(listener);
    await env.gate('listen');
    return () => {
      listener.live = false;
    };
  },
}));

vi.mock('../../../src/control/services/stt/local', () => ({
  STT_EVENT: 'stt://event',
  encodePcm16: (samples: Float32Array) => `frame-${samples[0]}`,
  startTranscription: async () => {
    env.state.loadCalls += 1;
    await env.gate('load');
    const generation = env.state.nextGeneration++;
    env.state.opened.push(generation);
    env.state.current = generation;
    return generation;
  },
  pushTranscriptionAudio: async (generation: number, chunk: string) => {
    env.state.pushed.push({ generation, chunk });
  },
  stopTranscription: async (generation: number) => {
    env.state.closed.push(generation);
    if (env.state.current === generation) env.state.current = null;
  },
}));

vi.mock('../../../src/control/services/audio/capture', () => ({
  PcmCapture: class {
    readonly contextSampleRate = 24_000;
    /** Set when setup FINISHES, whatever happened meanwhile — as the real one is. */
    active = false;
    readonly onFrame: (samples: Float32Array) => void;
    constructor(options: { onFrame: (samples: Float32Array) => void }) {
      this.onFrame = options.onFrame;
      env.state.taps.push(this);
    }
    async start(): Promise<void> {
      await env.gate('tap');
      this.active = true;
    }
    async stop(): Promise<void> {
      this.active = false;
    }
  },
}));

vi.mock('../../../src/control/services/audio', async (original) => ({
  ...(await original<typeof import('../../../src/control/services/audio')>()),
  createAnalyserGraph: async () => {
    await env.gate('meter');
    const graph = {
      closed: false,
      analyser: { fftSize: 32, getFloatTimeDomainData: () => {} },
      close: async () => {
        graph.closed = true;
      },
    };
    env.state.graphs.push(graph);
    return graph;
  },
}));

vi.mock('../../../src/control/services/audio-trace', () => ({
  traceBegin: () => {},
  trace: () => {},
}));

import { DEFAULT_ANALYSIS_INTERVAL_MS } from '../../../src/control/services/audio/defaults';
import { VoiceSessionPipeline } from '../../../src/control/services/voice-session';
import type { CompiledScript } from '../../../src/shared/contracts';

/** Every await `start()` makes, in the order it makes them. */
const START_BOUNDARIES = [
  'save',
  'compile',
  'permission',
  'listen',
  'getUserMedia',
  'backoff',
  'meter',
  'tap',
  'load',
] as const;
type Boundary = (typeof START_BOUNDARIES)[number];

/** The awaits a microphone switch makes. */
const SWITCH_BOUNDARIES = ['getUserMedia', 'backoff', 'meter', 'tap'] as const;

/** The start's awaits that a resume on the same pipeline does not queue behind. */
const UNSHARED: readonly Boundary[] = ['save', 'compile', 'permission', 'listen'];

const INTERRUPTS = {
  stop: (p: VoiceSessionPipeline) => p.stop(),
  'hard pause': (p: VoiceSessionPipeline) => p.hardPause(),
} as const;
type Interrupt = keyof typeof INTERRUPTS;

const NO_MODEL = { code: 'STT_MODEL_NOT_INSTALLED', userMessage: 'No model.' };

function before(at: Boundary, boundary: Boundary): boolean {
  return START_BOUNDARIES.indexOf(at) < START_BOUNDARIES.indexOf(boundary);
}

function fakeStream(device: string | undefined): FakeStream {
  const track: FakeTrack = {
    readyState: 'live',
    stop() {
      track.readyState = 'ended';
    },
  };
  return { device, track, getTracks: () => [track], getAudioTracks: () => [track] };
}

function installNavigator(): void {
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async (constraints: { audio: { deviceId?: { exact: string } } }) => {
        env.state.gumCalls += 1;
        if (env.state.busy > 0) {
          env.state.busy -= 1;
          throw Object.assign(new Error('device in use'), { name: 'NotReadableError' });
        }
        if (env.state.gumError !== null) {
          const err = env.state.gumError;
          env.state.gumError = null;
          throw err;
        }
        await env.gate('getUserMedia');
        const stream = fakeStream(constraints.audio.deviceId?.exact);
        env.state.streams.push(stream);
        return stream;
      },
      enumerateDevices: async () => [],
      addEventListener: (type: string) => {
        if (type === 'devicechange') env.state.watchers += 1;
      },
      removeEventListener: (type: string) => {
        if (type === 'devicechange') env.state.watchers -= 1;
      },
    },
    permissions: {
      query: async () => {
        await env.gate('permission');
        return { state: 'granted' };
      },
    },
  });
}

/** What one pipeline told its owner. */
interface Reports {
  states: string[];
  fannedOut: FakeStream[];
  texts: string[];
  lines: string[];
  levels: number;
  dropped: number[];
}

const pipelines: VoiceSessionPipeline[] = [];

function pipeline(): { p: VoiceSessionPipeline; reports: Reports } {
  const reports: Reports = {
    states: [],
    fannedOut: [],
    texts: [],
    lines: [],
    levels: 0,
    dropped: [],
  };
  const p = new VoiceSessionPipeline({
    sessionId: 'session-1',
    sessionGeneration: 1,
    compiled: { spokenTokens: [], spokenWordCount: 0 } as unknown as CompiledScript,
    startSequence: {
      flushScriptSave: () => env.gate('save'),
      ensureCompiled: () => env.gate('compile'),
    },
    onTranscriptText: (text) => reports.texts.push(text),
    onTranscriptLine: (line) => reports.lines.push(line),
    onConnectionState: (state) => reports.states.push(state),
    onCaptureStream: (stream) => reports.fannedOut.push(stream as unknown as FakeStream),
    onLevel: () => {
      reports.levels += 1;
    },
    onAudioDropped: (frames) => reports.dropped.push(frames),
    timers: {
      setTimeout: (callback) => env.state.timers.push(callback),
      clearTimeout: () => {},
    },
    now: () => 1_000,
  });
  pipelines.push(p);
  return { p, reports };
}

/** Hold the first call at `at`. */
function holdAt(at: Boundary): void {
  if (at === 'backoff') env.state.busy = 1;
  else env.state.holds.add(at);
}

/** Wait until an operation is parked at `at`. */
async function reached(at: Boundary): Promise<void> {
  await vi.waitFor(() => {
    if (at === 'backoff') expect(env.state.timers).toHaveLength(1);
    else expect(env.state.held.has(at)).toBe(true);
  });
}

/** Let the held call finish — late, after whatever the test did meanwhile. */
function release(at: Boundary, err?: unknown): void {
  if (at === 'backoff') {
    env.state.timers.shift()?.();
    return;
  }
  const held = env.state.held.get(at);
  env.state.held.delete(at);
  if (err === undefined) held?.release();
  else held?.fail(err);
}

/** A macrotask: every promise chain the release set off has run. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let spoken = 0;

/** Play one frame into every tap ever opened, live or not; each tap's chunk. */
function speakIntoEveryTap(): Map<FakeTap, string> {
  const chunks = new Map<FakeTap, string>();
  for (const tap of env.state.taps) {
    const samples = new Float32Array(2_400);
    samples[0] = spoken;
    samples[1] = 0.5;
    chunks.set(tap, `frame-${spoken}`);
    spoken += 1;
    tap.onFrame(samples);
  }
  return chunks;
}

/** Hand a Rust frame to every live STT listener, as the event bus would. */
function deliver(frame: SttFrame): void {
  for (const listener of env.state.listeners) {
    if (listener.live) listener.handler({ payload: frame });
  }
}

function liveStreams(): FakeStream[] {
  return env.state.streams.filter((stream) => stream.track.readyState === 'live');
}

function openGraphs(): Array<{ closed: boolean }> {
  return env.state.graphs.filter((graph) => !graph.closed);
}

function activeTaps(): FakeTap[] {
  return env.state.taps.filter((tap) => tap.active);
}

function liveListeners(): number {
  return env.state.listeners.filter((listener) => listener.live).length;
}

/**
 * The end state the issue asks for: nothing the take opened is still open.
 *
 * `kept` is for a hard pause on a take that had FINISHED starting, which keeps
 * its STT listener and device watcher as it always has: both are the
 * pipeline's own, and its resume uses them. A start interrupted part-way
 * leaves neither.
 */
function expectNothingOpen(kept = 0): void {
  expect(liveStreams(), 'every microphone stream is released').toEqual([]);
  expect(openGraphs(), 'every level-meter graph is closed').toEqual([]);
  expect(activeTaps(), 'every PCM tap is closed').toEqual([]);
  expect(
    env.state.opened.filter((generation) => !env.state.closed.includes(generation)),
    'every recogniser session is closed',
  ).toEqual([]);
  expect(env.state.current, 'Rust has no session open').toBeNull();
  expect(liveListeners(), 'no STT listener is left behind').toBe(kept);
  expect(env.state.watchers, 'no device watcher is left behind').toBe(kept);
}

/** Exactly one take is open, it is `owner`'s, and only its audio and words flow. */
async function expectOneLiveTake(owner: Reports): Promise<void> {
  expect(liveStreams(), 'one microphone, the live take’s').toEqual([owner.fannedOut.at(-1)]);
  expect(openGraphs()).toHaveLength(1);
  expect(activeTaps()).toHaveLength(1);
  expect(liveListeners()).toBe(1);
  expect(env.state.watchers).toBe(1);
  const generation = env.state.current;
  expect(generation, 'Rust is running the live take’s session').not.toBeNull();

  const chunks = speakIntoEveryTap();
  await settled();
  expect(env.state.pushed, 'its audio, and only its audio, reaches that session').toEqual([
    { generation, chunk: chunks.get(activeTaps()[0]!) },
  ]);

  const heard = owner.texts.length;
  deliver({ kind: 'partial', generation: 999, itemId: 'stale', text: 'someone else' });
  deliver({ kind: 'partial', generation: generation!, itemId: 'live', text: 'the live take' });
  expect(owner.texts.slice(heard), 'and only its words').toEqual(['the live take']);
}

beforeEach(() => {
  Object.assign(env.state, {
    holds: new Set(),
    held: new Map(),
    busy: 0,
    gumError: null,
    gumCalls: 0,
    streams: [],
    graphs: [],
    taps: [],
    listeners: [],
    watchers: 0,
    timers: [],
    loadCalls: 0,
    nextGeneration: 1,
    opened: [],
    closed: [],
    current: null,
    pushed: [],
  });
  spoken = 0;
  installNavigator();
});

afterEach(async () => {
  // Whatever a test left running — a real `MicrophoneMonitor` ticks on a real
  // interval — goes before the next one starts.
  env.state.holds.clear();
  for (const held of env.state.held.values()) held.release();
  env.state.held.clear();
  for (const callback of env.state.timers.splice(0)) callback();
  await Promise.all(pipelines.splice(0).map((p) => p.stop().catch(() => {})));
  vi.unstubAllGlobals();
});

describe('a take interrupted while it is still starting opens nothing (#289)', () => {
  for (const at of START_BOUNDARIES) {
    for (const interrupt of Object.keys(INTERRUPTS) as Interrupt[]) {
      it(`${interrupt} during ${at}`, async () => {
        const { p, reports } = pipeline();
        holdAt(at);
        const outcome = expect(p.start()).rejects.toThrow('SESSION_STOPPED');
        await reached(at);

        await INTERRUPTS[interrupt](p);
        const fannedOutBefore = reports.fannedOut.length;
        release(at);
        await outcome;
        await settled();
        speakIntoEveryTap();
        await settled();

        expectNothingOpen();
        expect(env.state.pushed, 'no audio reaches a recogniser').toEqual([]);
        expect(reports.fannedOut, 'no stream is handed on after the take ended').toHaveLength(
          fannedOutBefore,
        );
        expect(reports.states.at(-1), 'the take still reads offline').toBe('offline');
        // And the start went no further than where it was interrupted.
        if (before(at, 'listen')) expect(env.state.listeners).toEqual([]);
        if (before(at, 'getUserMedia')) expect(env.state.gumCalls).toBe(0);
        if (at === 'backoff') {
          expect(env.state.gumCalls, 'a stopped take does not ask for the device again').toBe(1);
        }
        if (before(at, 'load')) expect(env.state.loadCalls).toBe(0);
      });
    }
  }

  it('ends as SESSION_STOPPED even when the call it was waiting on then fails', async () => {
    const { p } = pipeline();
    holdAt('load');
    const outcome = expect(p.start()).rejects.toThrow('SESSION_STOPPED');
    await reached('load');

    await p.stop();
    release('load', NO_MODEL);
    await outcome;
    expectNothingOpen();
  });

  it('does not let a stale start’s session announce itself to a hard-paused take', async () => {
    const { p, reports } = pipeline();
    holdAt('load');
    const outcome = expect(p.start()).rejects.toThrow('SESSION_STOPPED');
    await reached('load');
    await p.hardPause();

    // Rust's session for the abandoned start comes up before its invoke returns.
    deliver({ kind: 'transport', generation: 1, state: 'connected' });
    deliver({ kind: 'partial', generation: 1, itemId: 'stale', text: 'nobody asked' });
    release('load');
    await outcome;

    expect(reports.states.at(-1), 'still paused, still offline').toBe('offline');
    expect(reports.texts).toEqual([]);
    expectNothingOpen();
  });

  it('reports no levels from a meter that finished opening after the take stopped', async () => {
    const live = pipeline();
    await live.p.start();
    // The real monitor on its real interval: there is something to suppress.
    await vi.waitFor(() => expect(live.reports.levels).toBeGreaterThan(0));
    await live.p.stop();

    const { p, reports } = pipeline();
    holdAt('meter');
    const outcome = expect(p.start()).rejects.toThrow('SESSION_STOPPED');
    await reached('meter');
    await p.stop();
    release('meter');
    await outcome;
    await new Promise((resolve) => setTimeout(resolve, 4 * DEFAULT_ANALYSIS_INTERVAL_MS));

    expect(reports.levels).toBe(0);
    expectNothingOpen();
  });
});

describe('a start that fails on its own still closes everything and keeps its reason', () => {
  it('a refused microphone', async () => {
    const { p, reports } = pipeline();
    env.state.gumError = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    await expect(p.start()).rejects.toThrow('MIC_PERMISSION_DENIED');
    expectNothingOpen();

    await p.start();
    await expectOneLiveTake(reports);
  });

  for (const [at, err] of [
    ['meter', new Error('ANALYSER_FAILED')],
    ['tap', new Error('AUDIO_CONTEXT_FAILED')],
    ['load', NO_MODEL],
  ] as const) {
    it(`a failure at ${at}`, async () => {
      const { p, reports } = pipeline();
      holdAt(at);
      const refused = p.start();
      await reached(at);
      release(at, err);
      await expect(refused).rejects.toBe(err);
      expectNothingOpen();

      // And nothing of it carries into the next attempt.
      await p.start();
      await expectOneLiveTake(reports);
    });
  }
});

describe('a new take started while the stopped one is still opening keeps everything it opens', () => {
  for (const at of START_BOUNDARIES) {
    it(`old take held at ${at}`, async () => {
      const first = pipeline();
      holdAt(at);
      const abandoned = expect(first.p.start()).rejects.toThrow('SESSION_STOPPED');
      await reached(at);
      await first.p.stop();
      const fannedOutBefore = first.reports.fannedOut.length;

      const second = pipeline();
      const started = second.p.start();
      if (at === 'load') {
        // The one thing two takes share: Rust holds one session, so the new
        // take's recogniser waits for the old one's to come back and close.
        await vi.waitFor(() => expect(activeTaps()).toHaveLength(1));
        await settled();
        expect(env.state.loadCalls, 'the new take has not asked yet').toBe(1);
      } else {
        // Fully open before the old take's call comes back.
        await started;
      }
      release(at);
      await abandoned;
      await started;
      await settled();

      expect(first.reports.fannedOut).toHaveLength(fannedOutBefore);
      await expectOneLiveTake(second.reports);
      await second.p.stop();
      expectNothingOpen();
    });
  }
});

describe('a resume after a hard pause keeps everything it opens', () => {
  for (const at of START_BOUNDARIES) {
    it(`start held at ${at}`, async () => {
      const { p, reports } = pipeline();
      holdAt(at);
      const abandoned = expect(p.start()).rejects.toThrow('SESSION_STOPPED');
      await reached(at);
      await p.hardPause();

      const resumed = p.resume();
      // Past the abandoned start's await the resume waits its turn: the
      // microphone is opened one acquisition at a time, and Rust's session one
      // start at a time.
      if (UNSHARED.includes(at)) await resumed;
      else await settled();
      release(at);
      await abandoned;
      await resumed;
      await settled();

      expect(reports.states.at(-1)).toBe('reconnecting');
      await expectOneLiveTake(reports);
      await p.stop();
      expectNothingOpen();
    });
  }

  it('a resume while the start is still opening joins it instead of opening a second microphone', async () => {
    const { p } = pipeline();
    holdAt('load');
    const started = p.start();
    await reached('load');

    p.softPause();
    const resumed = p.resume();
    release('load');
    await started;
    await resumed;

    expect(env.state.gumCalls).toBe(1);
    expect(env.state.taps).toHaveLength(1);
    expect(env.state.opened).toHaveLength(1);
    expect(liveStreams()).toHaveLength(1);
  });

  it('a second resume answers when the first has reopened, not before', async () => {
    const { p } = pipeline();
    await p.start();
    await p.hardPause();
    holdAt('getUserMedia');
    const first = p.resume();
    await reached('getUserMedia');

    let secondAnswered = false;
    const second = p.resume().then(() => {
      secondAnswered = true;
    });
    await settled();
    expect(secondAnswered, 'nothing is open yet for it to report').toBe(false);

    release('getUserMedia');
    await first;
    await second;
    expect(secondAnswered).toBe(true);
    expect(liveStreams()).toHaveLength(1);
  });

  it('a resume that failed leaves the take paused, so the next one reopens it', async () => {
    const { p, reports } = pipeline();
    await p.start();
    await p.hardPause();
    holdAt('load');
    const refused = p.resume();
    await reached('load');
    release('load', NO_MODEL);
    await expect(refused).rejects.toBe(NO_MODEL);

    await p.resume();
    await expectOneLiveTake(reports);
  });

  it('a resume a second pause overtook does not pause the resume after it', async () => {
    const { p, reports } = pipeline();
    await p.start();
    await p.hardPause();
    holdAt('save');
    const overtaken = expect(p.resume()).rejects.toThrow('SESSION_STOPPED');
    await reached('save');
    await p.hardPause();
    await p.resume();

    release('save');
    await overtaken;
    await settled();
    // Still live: audio flows, which it would not on a take quietly re-paused.
    await expectOneLiveTake(reports);
  });

  it('a hard pause that overtakes a resume says offline again', async () => {
    // The store marks a resume `reconnecting` before the pipeline has said
    // anything, so a pause the pipeline thinks is a repeat is news to it.
    const { p, reports } = pipeline();
    await p.start();
    await p.hardPause();
    holdAt('save');
    const resumed = expect(p.resume()).rejects.toThrow('SESSION_STOPPED');
    await reached('save');
    const offline = () => reports.states.filter((state) => state === 'offline').length;
    const before = offline();

    await p.hardPause();
    release('save');
    await resumed;
    expect(offline()).toBe(before + 1);
  });
});

describe('a microphone switch interrupted mid-way opens nothing (#289)', () => {
  for (const at of SWITCH_BOUNDARIES) {
    for (const interrupt of Object.keys(INTERRUPTS) as Interrupt[]) {
      it(`${interrupt} during the switch's ${at}`, async () => {
        const { p, reports } = pipeline();
        await p.start();

        holdAt(at);
        const outcome = expect(p.switchMicrophone('usb')).rejects.toThrow('SESSION_STOPPED');
        await reached(at);
        // Held at the tap, the switch has already handed on a stream it
        // acquired while the take was running; that one is legitimate.
        const fannedOutBefore = reports.fannedOut.length;
        await INTERRUPTS[interrupt](p);
        release(at);
        await outcome;
        await settled();
        speakIntoEveryTap();
        await settled();

        expectNothingOpen(interrupt === 'hard pause' ? 1 : 0);
        expect(env.state.pushed, 'no audio reaches a recogniser').toEqual([]);
        expect(reports.fannedOut, 'no stream is handed on after the take ended').toHaveLength(
          fannedOutBefore,
        );
        if (at === 'backoff') expect(env.state.gumCalls).toBe(2);
      });
    }

    it(`a second switch queued behind one held at ${at} ends on the device asked for last`, async () => {
      const { p, reports } = pipeline();
      await p.start();
      holdAt(at);
      const first = p.switchMicrophone('first');
      await reached(at);
      const second = p.switchMicrophone('second');
      await settled();
      release(at);
      await first;
      await second;
      await settled();

      expect(liveStreams().map((stream) => stream.device)).toEqual(['second']);
      expect(reports.fannedOut.at(-1)?.device).toBe('second');
      expect(openGraphs()).toHaveLength(1);
      expect(activeTaps()).toHaveLength(1);
    });

    it(`a new take started while the stopped one's switch is held at ${at} keeps everything it opens`, async () => {
      const first = pipeline();
      await first.p.start();
      holdAt(at);
      const abandoned = expect(first.p.switchMicrophone('usb')).rejects.toThrow(
        'SESSION_STOPPED',
      );
      await reached(at);
      await first.p.stop();

      const second = pipeline();
      await second.p.start();
      release(at);
      await abandoned;
      await settled();

      await expectOneLiveTake(second.reports);
      await second.p.stop();
      expectNothingOpen();
    });
  }

  it('waits for a start that is still opening the microphone, and leaves one open', async () => {
    const { p, reports } = pipeline();
    holdAt('getUserMedia');
    const started = p.start();
    await reached('getUserMedia');

    const switched = p.switchMicrophone('usb');
    await settled();
    expect(env.state.gumCalls, 'the switch waits its turn').toBe(1);
    release('getUserMedia');
    await started;
    await switched;
    await settled();

    expect(env.state.gumCalls).toBe(2);
    expect(liveStreams(), 'the switched device, and only it').toEqual([reports.fannedOut.at(-1)]);
    expect(reports.fannedOut.at(-1)?.device).toBe('usb');
    expect(openGraphs()).toHaveLength(1);
    expect(activeTaps()).toHaveLength(1);

    await p.stop();
    expectNothingOpen();
  });

  it('opens nothing when the start it was switching under fails', async () => {
    const { p } = pipeline();
    holdAt('load');
    const started = p.start();
    await reached('load');
    holdAt('getUserMedia');
    const switched = expect(p.switchMicrophone('usb')).rejects.toThrow('SESSION_STOPPED');
    await reached('getUserMedia');

    release('load', NO_MODEL);
    await expect(started).rejects.toBe(NO_MODEL);
    release('getUserMedia');
    await switched;
    await settled();
    expectNothingOpen();
  });

  it('forwards nothing from the tap a switch replaced', async () => {
    const { p } = pipeline();
    await p.start();
    const [replaced] = env.state.taps;
    await p.switchMicrophone('usb');

    // A late callback from the old graph, already queued when it was closed.
    replaced!.onFrame(new Float32Array(2_400).fill(0.5));
    await settled();
    expect(env.state.pushed).toEqual([]);
  });
});

describe('the STT listener hears only the take it belongs to (#289)', () => {
  it('a take opening keeps its own session’s first frames and drops anyone else’s', async () => {
    const { p, reports } = pipeline();
    holdAt('load');
    const started = p.start();
    await reached('load');

    // Another session's words, and this take's own session announcing itself
    // before `start_transcription` has returned its generation.
    deliver({ kind: 'partial', generation: 7, itemId: 'other', text: 'not this take' });
    deliver({ kind: 'transport', generation: 1, state: 'connected' });
    expect(reports.states.at(-1), 'nothing applied before the generation is known').toBe(
      'reconnecting',
    );
    release('load');
    await started;

    expect(reports.states.at(-1)).toBe('connected');
    expect(reports.texts).toEqual([]);
  });

  it('a hard-paused take still hears its own session finish, and nobody else’s', async () => {
    const { p, reports } = pipeline();
    await p.start();
    await p.hardPause();

    deliver({
      kind: 'final',
      generation: 1,
      itemId: 'last',
      text: 'the last words',
      audioEndMs: 900,
    });
    deliver({ kind: 'audioDropped', generation: 1, frames: 3 });
    deliver({ kind: 'transport', generation: 1, state: 'closed' });
    deliver({ kind: 'partial', generation: 2, itemId: 'other', text: 'someone else' });
    deliver({ kind: 'transport', generation: 2, state: 'connected' });

    expect(reports.lines).toEqual(['the last words']);
    expect(reports.texts).toEqual(['the last words']);
    expect(reports.dropped).toEqual([3]);
    expect(reports.states.at(-1)).toBe('offline');
  });

  it('a soft pause that auto-disconnects hears its session close', async () => {
    const { p, reports } = pipeline();
    await p.start();
    deliver({ kind: 'transport', generation: 1, state: 'connected' });
    p.softPause();

    // The auto-disconnect, on the pipeline's timer seam.
    env.state.timers.shift()?.();
    await settled();
    expect(env.state.closed).toEqual([1]);
    deliver({ kind: 'transport', generation: 1, state: 'closed' });
    expect(reports.states.at(-1)).toBe('offline');
  });
});
