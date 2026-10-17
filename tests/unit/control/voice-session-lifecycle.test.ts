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
 * hazard, so a forgiving mock cannot hide a leak.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTrack {
  readyState: 'live' | 'ended';
  stop(): void;
}

interface FakeStream {
  track: FakeTrack;
  getTracks(): FakeTrack[];
  getAudioTracks(): FakeTrack[];
}

interface FakeTap {
  active: boolean;
  onFrame(samples: Float32Array): void;
}

const env = vi.hoisted(() => {
  const state = {
    /** The boundary whose FIRST call is held; cleared as soon as it is. */
    hold: null as string | null,
    held: null as null | { at: string; release: () => void; fail: (err: unknown) => void },
    /** `getUserMedia` rejects as busy this many more times. */
    busy: 0,
    gumCalls: 0,
    streams: [] as FakeStream[],
    graphs: [] as Array<{ closed: boolean }>,
    taps: [] as FakeTap[],
    listeners: [] as Array<{ live: boolean }>,
    watchers: 0,
    /** The pipeline's timer seam: the busy backoff waits on these. */
    timers: [] as Array<() => void>,
    nextGeneration: 1,
    opened: [] as number[],
    closed: [] as number[],
    /** Rust holds ONE session, and a start replaces it. */
    current: null as number | null,
    pushed: [] as Array<{ generation: number; chunk: string }>,
    /** Makes the held call reject instead of resolving. */
    loadError: null as unknown,
  };
  function gate(at: string): Promise<void> {
    if (state.hold !== at) return Promise.resolve();
    state.hold = null;
    return new Promise<void>((release, fail) => {
      state.held = { at, release, fail };
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
  listen: async () => {
    // Registered when asked for, as Tauri's is; the cleanup handle arrives later.
    const listener = { live: true };
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

const INTERRUPTS = {
  stop: (p: VoiceSessionPipeline) => p.stop(),
  'hard pause': (p: VoiceSessionPipeline) => p.hardPause(),
} as const;
type Interrupt = keyof typeof INTERRUPTS;

function before(at: Boundary, boundary: Boundary): boolean {
  return START_BOUNDARIES.indexOf(at) < START_BOUNDARIES.indexOf(boundary);
}

function fakeStream(): FakeStream {
  const track: FakeTrack = {
    readyState: 'live',
    stop() {
      track.readyState = 'ended';
    },
  };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}

function installNavigator(): void {
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => {
        env.state.gumCalls += 1;
        if (env.state.busy > 0) {
          env.state.busy -= 1;
          throw Object.assign(new Error('device in use'), { name: 'NotReadableError' });
        }
        await env.gate('getUserMedia');
        const stream = fakeStream();
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
}

const pipelines: VoiceSessionPipeline[] = [];

function pipeline(): { p: VoiceSessionPipeline; reports: Reports } {
  const reports: Reports = { states: [], fannedOut: [] };
  const p = new VoiceSessionPipeline({
    sessionId: 'session-1',
    sessionGeneration: 1,
    compiled: { spokenTokens: [], spokenWordCount: 0 } as unknown as CompiledScript,
    startSequence: {
      flushScriptSave: () => env.gate('save'),
      ensureCompiled: () => env.gate('compile'),
    },
    onTranscriptText: () => {},
    onTranscriptLine: () => {},
    onConnectionState: (state) => reports.states.push(state),
    onCaptureStream: (stream) => reports.fannedOut.push(stream as unknown as FakeStream),
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
  else env.state.hold = at;
}

/** Wait until the operation is parked at `at`. */
async function reached(at: Boundary): Promise<void> {
  await vi.waitFor(() => {
    if (at === 'backoff') expect(env.state.timers).toHaveLength(1);
    else expect(env.state.held?.at).toBe(at);
  });
}

/** Let the held call finish — late, after whatever the test did meanwhile. */
function release(at: Boundary): void {
  if (at === 'backoff') {
    env.state.timers.shift()?.();
    return;
  }
  const held = env.state.held;
  env.state.held = null;
  if (env.state.loadError !== null) held?.fail(env.state.loadError);
  else held?.release();
}

/** A macrotask: every promise chain the release set off has run. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let spoken = 0;

/** Play a frame into every tap that was ever opened, live or not. */
function speakIntoEveryTap(): void {
  for (const tap of env.state.taps) {
    const samples = new Float32Array(2_400);
    samples[0] = spoken;
    samples[1] = 0.5;
    spoken += 1;
    tap.onFrame(samples);
  }
}

function liveStreams(): FakeStream[] {
  return env.state.streams.filter((stream) => stream.track.readyState === 'live');
}

/**
 * The end state the issue asks for: nothing the take opened is still open.
 *
 * A hard pause on a take that had finished starting keeps its device watcher,
 * as it keeps its STT listener: both are the pipeline's own, and the resume
 * uses them.
 */
function expectNothingOpen(watchers = 0): void {
  expect(liveStreams(), 'every microphone stream is released').toEqual([]);
  expect(
    env.state.graphs.filter((graph) => !graph.closed),
    'every level-meter graph is closed',
  ).toEqual([]);
  expect(
    env.state.taps.filter((tap) => tap.active),
    'every PCM tap is closed',
  ).toEqual([]);
  expect(
    env.state.opened.filter((generation) => !env.state.closed.includes(generation)),
    'every recogniser session is closed',
  ).toEqual([]);
  expect(env.state.current, 'Rust has no session open').toBeNull();
  expect(env.state.watchers, 'no device watcher is left behind').toBe(watchers);
}

function liveListeners(): number {
  return env.state.listeners.filter((listener) => listener.live).length;
}

beforeEach(() => {
  Object.assign(env.state, {
    hold: null,
    held: null,
    busy: 0,
    gumCalls: 0,
    streams: [],
    graphs: [],
    taps: [],
    listeners: [],
    watchers: 0,
    timers: [],
    nextGeneration: 1,
    opened: [],
    closed: [],
    current: null,
    pushed: [],
    loadError: null,
  });
  spoken = 0;
  installNavigator();
});

afterEach(async () => {
  // Whatever a test left running — a real `MicrophoneMonitor` ticks on a real
  // interval — goes before the next one starts.
  env.state.held?.release();
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
        if (before(at, 'load')) expect(env.state.opened).toEqual([]);
        if (interrupt === 'stop') expect(liveListeners(), 'the STT listener is gone').toBe(0);
        // A hard pause keeps at most the pipeline's own listener, for resume.
        else expect(liveListeners()).toBeLessThanOrEqual(1);
      });
    }
  }

  it('ends as SESSION_STOPPED even when the call it was waiting on then fails', async () => {
    const { p } = pipeline();
    holdAt('load');
    env.state.loadError = { code: 'STT_MODEL_NOT_INSTALLED', userMessage: 'No model.' };
    const outcome = expect(p.start()).rejects.toThrow('SESSION_STOPPED');
    await reached('load');

    await p.stop();
    release('load');
    await outcome;
    expectNothingOpen();
  });
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
      // As far as it can go before the old take's call comes back. Only the
      // recogniser load is shared, so only that one makes it wait.
      await settled();
      release(at);
      await abandoned;
      await started;
      await settled();

      const [stream] = second.reports.fannedOut;
      expect(liveStreams(), 'only the new take holds a microphone').toEqual([stream]);
      expect(env.state.graphs.filter((graph) => !graph.closed)).toHaveLength(1);
      expect(env.state.taps.filter((tap) => tap.active)).toHaveLength(1);
      expect(liveListeners()).toBe(1);
      expect(env.state.watchers).toBe(1);
      expect(first.reports.fannedOut).toHaveLength(fannedOutBefore);

      // The new take's session is the one Rust is running, and its audio
      // reaches it — the old take's late load did not replace it.
      expect(env.state.current).not.toBeNull();
      speakIntoEveryTap();
      await settled();
      expect(env.state.pushed.length).toBeGreaterThan(0);
      expect(new Set(env.state.pushed.map((frame) => frame.generation))).toEqual(
        new Set([env.state.current]),
      );

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
      await settled();
      release(at);
      await abandoned;
      await resumed;
      await settled();

      expect(liveStreams(), 'one microphone, the resume’s').toEqual([reports.fannedOut.at(-1)]);
      expect(env.state.graphs.filter((graph) => !graph.closed)).toHaveLength(1);
      expect(env.state.taps.filter((tap) => tap.active)).toHaveLength(1);
      expect(liveListeners()).toBe(1);
      expect(env.state.watchers).toBe(1);
      expect(reports.states.at(-1)).toBe('reconnecting');

      expect(env.state.current).not.toBeNull();
      speakIntoEveryTap();
      await settled();
      expect(env.state.pushed.length).toBeGreaterThan(0);
      expect(new Set(env.state.pushed.map((frame) => frame.generation))).toEqual(
        new Set([env.state.current]),
      );

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
        expect(reports.fannedOut, 'no stream is handed on after the take ended').toHaveLength(
          fannedOutBefore,
        );
        if (at === 'backoff') expect(env.state.gumCalls).toBe(2);
        // Only frames the take sent while it was running, none after.
        const generations = new Set(env.state.pushed.map((frame) => frame.generation));
        expect(generations.size).toBeLessThanOrEqual(1);
      });
    }
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
    expect(env.state.graphs.filter((graph) => !graph.closed)).toHaveLength(1);
    expect(env.state.taps.filter((tap) => tap.active)).toHaveLength(1);

    await p.stop();
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
