/**
 * A take whose `push_transcription_audio` stalls (#288).
 *
 * Every 100 ms frame used to be chained onto one promise, so a push that never
 * came back held every frame after it in the renderer, without limit, and the
 * loss reached nobody: Rust cannot count frames it never receives, and the
 * trace went on saying frames were sent. Now a bounded queue stands at the IPC
 * edge and reports what it sheds through the same `onAudioDropped` Rust's own
 * drops use.
 *
 * Driven through the real `VoiceSessionPipeline`. Only its edges are doubles:
 * the microphone, the PCM tap (frames are played into it by hand, one per
 * 100 ms of a clock the test owns), and the IPC wrappers, whose push settles
 * only when a test lets it. What this proves is the renderer's bookkeeping. It
 * does not prove how a real WKWebView bridge stalls, nor how the recogniser and
 * the cursor recover from the gap on a real take with a real microphone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Push {
  generation: number;
  chunk: string;
  settle(): void;
  refuse(): void;
}

const stt = vi.hoisted(() => ({
  pushes: [] as Push[],
  delivered: [] as Array<{ generation: number; chunk: string }>,
  settled: new Set<Push>(),
  /** While set, pushes stay pending until a test settles them. */
  stalled: false,
  generations: [] as number[],
  closed: [] as number[],
}));

vi.mock('../../../src/control/services/stt/local', () => ({
  STT_EVENT: 'stt://event',
  // Each frame is identified by its first sample, so order survives encoding.
  encodePcm16: (samples: Float32Array) => `frame-${samples[0]}`,
  startTranscription: async () => stt.generations.shift() ?? 1,
  pushTranscriptionAudio: (generation: number, chunk: string) =>
    new Promise<void>((resolve, reject) => {
      const push: Push = {
        generation,
        chunk,
        settle: () => {
          stt.settled.add(push);
          stt.delivered.push({ generation, chunk });
          resolve();
        },
        refuse: () => {
          stt.settled.add(push);
          reject({ code: 'STT_PUSH_FAILED' });
        },
      };
      stt.pushes.push(push);
      if (!stt.stalled) push.settle();
    }),
  stopTranscription: async (generation: number) => {
    stt.closed.push(generation);
  },
}));

const taps = vi.hoisted(
  () => [] as Array<{ onFrame: (samples: Float32Array) => void; stopped: boolean }>,
);

vi.mock('../../../src/control/services/audio/capture', () => ({
  PcmCapture: class {
    readonly contextSampleRate = 24_000;
    stopped = false;
    readonly onFrame: (samples: Float32Array) => void;
    constructor(options: { onFrame: (samples: Float32Array) => void }) {
      this.onFrame = options.onFrame;
      taps.push(this);
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {
      this.stopped = true;
    }
  },
}));

vi.mock('../../../src/control/services/audio', async (original) => ({
  ...(await original<typeof import('../../../src/control/services/audio')>()),
  requestMicrophoneAccess: async () => ({
    ok: true,
    stream: { getTracks: () => [], getAudioTracks: () => [] },
    attempts: 1,
    fellBackToDefault: false,
  }),
  releaseStream: () => {},
  MicrophoneMonitor: class {
    onLevel(): () => void {
      return () => {};
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  },
}));

const traces = vi.hoisted(() => [] as Array<[string, string]>);

vi.mock('../../../src/control/services/audio-trace', () => ({
  traceBegin: () => {},
  trace: (step: string, detail = '') => {
    traces.push([step, detail]);
  },
}));

import { AUDIO_SEND_QUEUE_FRAMES } from '../../../src/control/services/audio/send-queue';
import {
  VoiceSessionPipeline,
  type VoicePipelineDeps,
} from '../../../src/control/services/voice-session';
import type { CompiledScript } from '../../../src/shared/contracts';

/** What the take was told about audio that never reached the recogniser. */
const dropped: number[] = [];
let clock = 0;
let spoken = 0;

function pipeline(extra: Partial<VoicePipelineDeps> = {}): VoiceSessionPipeline {
  return new VoiceSessionPipeline({
    sessionId: 'session-1',
    sessionGeneration: 1,
    compiled: { spokenTokens: [], spokenWordCount: 0 } as unknown as CompiledScript,
    onTranscriptText: () => {},
    onTranscriptLine: () => {},
    onConnectionState: () => {},
    onAudioDropped: (frames) => dropped.push(frames),
    now: () => clock,
    ...extra,
  });
}

/** Play `count` frames into the newest PCM tap, one per 100 ms, in speaking order. */
function speak(count: number): void {
  const tap = taps.at(-1);
  if (!tap) throw new Error('no PCM tap is open');
  for (let i = 0; i < count; i += 1) {
    clock += 100;
    const samples = new Float32Array(2_400);
    samples[0] = spoken;
    samples[1] = 0.5; // carries signal, like speech
    spoken += 1;
    tap.onFrame(samples);
  }
}

function frames(from: number, to: number): string[] {
  return Array.from({ length: to - from }, (_, i) => `frame-${from + i}`);
}

function outstanding(): Push[] {
  return stt.pushes.filter((push) => !stt.settled.has(push));
}

function deliveredChunks(): string[] {
  return stt.delivered.map((frame) => frame.chunk);
}

/** Let every settled push's continuation run. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

beforeEach(() => {
  stt.pushes.length = 0;
  stt.delivered.length = 0;
  stt.settled.clear();
  stt.stalled = false;
  stt.generations = [7];
  stt.closed.length = 0;
  taps.length = 0;
  traces.length = 0;
  dropped.length = 0;
  clock = 0;
  spoken = 0;
});

describe('a push that stalls for longer than the frame cadence', () => {
  it('holds bounded work, says so during the stall, and resumes on current audio', async () => {
    const p = pipeline();
    await p.start();
    speak(3);
    await settled();
    expect(deliveredChunks()).toEqual(frames(0, 3));

    // The fourth push never comes back, and the presenter keeps talking.
    stt.stalled = true;
    speak(1);
    const lost = 30;
    speak(AUDIO_SEND_QUEUE_FRAMES + lost);
    await settled();

    // Bounded: one call outstanding, and nothing else sent past it.
    expect(outstanding().map((push) => push.chunk)).toEqual(['frame-3']);
    expect(stt.pushes).toHaveLength(4);
    // Diagnosed while it is still stuck, through the toast Rust's drops use.
    expect(dropped.length, 'the presenter hears about it before it clears').toBeGreaterThan(0);
    expect(traces.some(([step]) => step === 'audio-dropped')).toBe(true);
    // And the progress trace no longer counts frames that never left.
    expect(traces.filter(([step]) => step === 'audio')).toEqual([
      ['audio', '1 frames delivered (0.1s)'],
    ]);

    stt.stalled = false;
    outstanding()[0]!.settle();
    await settled();
    // The stuck frame, then the newest that fit, then live audio as normal —
    // not the whole stall replayed into a recogniser that is now behind.
    const firstKept = 4 + lost;
    expect(deliveredChunks()).toEqual([
      ...frames(0, 4),
      ...frames(firstKept, firstKept + AUDIO_SEND_QUEUE_FRAMES),
    ]);
    expect(sum(dropped), 'every frame shed is reported, once').toBe(lost);

    speak(2);
    await settled();
    expect(deliveredChunks().slice(-2)).toEqual(frames(spoken - 2, spoken));
    expect(new Set(stt.delivered.map((frame) => frame.generation))).toEqual(new Set([7]));
    expect(sum(dropped)).toBe(lost);
    await p.stop();
  });

  it('reports a refused push and keeps the frames after it flowing', async () => {
    const p = pipeline();
    await p.start();
    stt.stalled = true;
    speak(2);
    outstanding()[0]!.refuse();
    await settled();
    // A rejection used to be caught and discarded without even a trace line.
    expect(dropped).toEqual([1]);
    expect(traces.find(([step]) => step === 'audio-dropped')?.[1]).toContain('rejected 1');

    stt.stalled = false;
    outstanding()[0]!.settle();
    await settled();
    expect(deliveredChunks()).toEqual(['frame-1']);
    await p.stop();
  });

  it('sends nothing more, and reports nothing, once the take has stopped', async () => {
    const p = pipeline();
    await p.start();
    stt.stalled = true;
    speak(1 + AUDIO_SEND_QUEUE_FRAMES);
    const reported = [...dropped];

    await p.stop();
    outstanding()[0]!.settle();
    await settled();

    expect(stt.pushes, 'the backlog belonged to a session that has closed').toHaveLength(1);
    expect(dropped, 'no notice for a take that is over').toEqual(reported);
    expect(stt.closed).toEqual([7]);
  });

  it('a new session is not held behind a push from the one before it', async () => {
    const p = pipeline();
    stt.generations = [7, 8];
    await p.start();
    stt.stalled = true;
    speak(3);
    expect(outstanding().map((push) => push.generation)).toEqual([7]);

    // The way out of a call that never settles: a fresh session, with a fresh
    // queue. Rust ignores the stale generation if the old call ever lands.
    await p.hardPause();
    stt.stalled = false;
    await p.resume();
    speak(2);
    await settled();

    expect(stt.delivered).toEqual([
      { generation: 8, chunk: 'frame-3' },
      { generation: 8, chunk: 'frame-4' },
    ]);

    // And when the old call does land at last, it changes nothing for the new
    // session: its backlog stays unsent and the new queue keeps flowing.
    stt.pushes.find((push) => push.generation === 7)!.settle();
    await settled();
    speak(1);
    await settled();
    expect(stt.pushes.filter((push) => push.generation === 7).map((push) => push.chunk)).toEqual([
      'frame-0',
    ]);
    expect(stt.delivered.at(-1)).toEqual({ generation: 8, chunk: 'frame-5' });
    expect(dropped).toEqual([]);
    await p.stop();
  });

  it('keeps one queue, in order, across a microphone switch mid-stall', async () => {
    const p = pipeline();
    await p.start();
    stt.stalled = true;
    speak(2);
    // Re-acquiring the device replaces the PCM tap, not the session: the
    // frames still waiting must go out ahead of what the new tap hears.
    await p.switchMicrophone('usb');
    expect(taps).toHaveLength(2);
    speak(2);
    expect(outstanding().map((push) => push.chunk)).toEqual(['frame-0']);

    stt.stalled = false;
    outstanding()[0]!.settle();
    await settled();
    expect(deliveredChunks()).toEqual(frames(0, 4));
    expect(dropped).toEqual([]);
    await p.stop();
  });

  it('sends nothing more once a soft pause has timed out and closed the session', async () => {
    const armed: Array<() => void> = [];
    const p = pipeline({
      softPauseAutoDisconnectMs: 60_000,
      timers: {
        setTimeout: (callback) => {
          armed.push(callback);
          return armed.length;
        },
        clearTimeout: () => {},
      },
    });
    await p.start();
    stt.stalled = true;
    speak(3);
    p.softPause();
    expect(armed, 'the soft pause armed its auto-disconnect').toHaveLength(1);
    armed[0]!();
    await settled();
    expect(stt.closed).toEqual([7]);

    outstanding()[0]!.settle();
    await settled();
    expect(stt.pushes, 'the frames waiting belonged to the session that closed').toHaveLength(1);
    expect(dropped).toEqual([]);
    await p.stop();
  });
});
