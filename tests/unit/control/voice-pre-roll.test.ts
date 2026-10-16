/**
 * The opening words of a take, heard while the recogniser is still loading
 * (#257).
 *
 * `start_transcription` loads the model when it is not resident — over a
 * second on the first take after launch, and on the first after a model
 * change. Capture used to wait for it, so the microphone sat open recording
 * nothing and the presenter's first words never reached the recogniser. Now
 * capture opens first and what it hears is held until the session exists.
 *
 * Driven through the real `VoiceSessionPipeline.start()`. Only its edges are
 * doubles: the microphone, the PCM tap (which this file plays frames into by
 * hand), and the IPC wrappers, whose `startTranscription` stays pending until
 * a test decides the load has finished.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stt = vi.hoisted(() => ({
  pushed: [] as Array<{ generation: number; chunk: string }>,
  closed: [] as number[],
  load: null as { resolve: (generation: number) => void; reject: (err: unknown) => void } | null,
}));

vi.mock('../../../src/control/services/stt/local', () => ({
  STT_EVENT: 'stt://event',
  // Each frame is identified by its first sample, so order survives encoding.
  encodePcm16: (samples: Float32Array) => `frame-${samples[0]}`,
  startTranscription: () =>
    new Promise<number>((resolve, reject) => {
      stt.load = { resolve, reject };
    }),
  pushTranscriptionAudio: async (generation: number, chunk: string) => {
    stt.pushed.push({ generation, chunk });
  },
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

import {
  PRE_ROLL_MAX_FRAMES,
  VoiceSessionPipeline,
} from '../../../src/control/services/voice-session';
import type { CompiledScript } from '../../../src/shared/contracts';

/** What the take was told about audio that never reached the recogniser. */
const dropped: number[] = [];

function pipeline(): VoiceSessionPipeline {
  return new VoiceSessionPipeline({
    sessionId: 'session-1',
    sessionGeneration: 1,
    compiled: { spokenTokens: [], spokenWordCount: 0 } as unknown as CompiledScript,
    onTranscriptText: () => {},
    onTranscriptLine: () => {},
    onConnectionState: () => {},
    onAudioDropped: (frames) => dropped.push(frames),
    now: () => 1_000,
  });
}

/** Wait until `start()` is parked on the model load. */
async function loading(): Promise<{
  resolve: (generation: number) => void;
  reject: (err: unknown) => void;
}> {
  await vi.waitFor(() => expect(stt.load).not.toBeNull());
  return stt.load!;
}

let spoken = 0;

/** Play `count` frames into the newest PCM tap, numbered in speaking order. */
function speak(count: number): void {
  const tap = taps.at(-1);
  if (!tap) throw new Error('no PCM tap is open');
  for (let i = 0; i < count; i += 1) {
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

/**
 * Let the send chain drain.
 *
 * A macrotask, not a count of microtask ticks: every push is a `.then` hop on
 * an already-settled chain, so all of them run before a timer can fire, however
 * long the backlog. A fixed number of ticks would drain twelve frames and not
 * forty, and the remainder would land in the next test's assertions.
 */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  stt.pushed.length = 0;
  stt.closed.length = 0;
  stt.load = null;
  taps.length = 0;
  traces.length = 0;
  dropped.length = 0;
  spoken = 0;
});

describe('a take hears its opening words while the recogniser loads', () => {
  it('opens the PCM tap before the recogniser has answered', async () => {
    const p = pipeline();
    const started = p.start();
    await loading();

    // The ordering itself: the load is still pending and the tap is already
    // open. Before #257 there was no tap until `start_transcription` returned.
    expect(taps).toHaveLength(1);

    stt.load!.resolve(7);
    await started;
    await p.stop();
  });

  it('delivers what was said during the load, in order, ahead of the first live frame', async () => {
    const p = pipeline();
    const started = p.start();
    const load = await loading();

    // ~1.2 s, the measured median cold load.
    speak(12);
    expect(stt.pushed, 'nothing can be sent before there is a session').toEqual([]);

    load.resolve(7);
    await started;
    speak(2);
    await settled();

    expect(stt.pushed.map((frame) => frame.chunk)).toEqual(frames(0, 14));
    expect(new Set(stt.pushed.map((frame) => frame.generation))).toEqual(new Set([7]));
    expect(dropped, 'nothing within the bound is reported lost').toEqual([]);
    expect(traces).toContainEqual(['pre-roll', '12 frames held for the recogniser (1.2s)']);
    await p.stop();
  });

  it('keeps the backlog ahead of a frame captured the instant the session opens', async () => {
    const p = pipeline();
    const started = p.start();
    const load = await loading();

    speak(12);
    load.resolve(7);
    // Queued behind the continuation of `start()` that assigns the generation.
    // An `await` between that assignment and the release would let this frame
    // through with the new generation ahead of everything held before it.
    queueMicrotask(() => speak(1));
    await started;
    await settled();

    expect(stt.pushed.map((frame) => frame.chunk)).toEqual(frames(0, 13));
    await p.stop();
  });

  it('keeps what was said before a microphone switch made during the load', async () => {
    const p = pipeline();
    const started = p.start();
    const load = await loading();

    speak(3);
    await p.switchMicrophone('usb');
    expect(taps, 'the switch opened a second tap').toHaveLength(2);
    expect(taps[0].stopped).toBe(true);
    speak(2);
    load.resolve(5);
    await started;
    await settled();

    // Re-acquiring the device tears down the old audio graph; it must not take
    // the presenter's opening words with it.
    expect(stt.pushed.map((frame) => frame.chunk)).toEqual(frames(0, 5));
    expect(new Set(stt.pushed.map((frame) => frame.generation))).toEqual(new Set([5]));
    await p.stop();
  });

  it('sends nothing held to a take that was soft-paused before the load finished', async () => {
    const p = pipeline();
    const started = p.start();
    const load = await loading();

    speak(3);
    p.softPause();
    speak(2);
    load.resolve(6);
    await started;
    await settled();
    expect(stt.pushed, 'a paused take is sent no audio, held or live').toEqual([]);

    await p.resume();
    speak(2);
    await settled();
    expect(stt.pushed.map((frame) => frame.chunk)).toEqual(frames(5, 7));
    await p.stop();
  });

  it('holds at most PRE_ROLL_MAX_FRAMES, shedding the oldest', async () => {
    const p = pipeline();
    const started = p.start();
    const load = await loading();

    // Past the bound: a load in the five-second tail the logs have recorded.
    const shed = 5;
    speak(PRE_ROLL_MAX_FRAMES + shed);
    load.resolve(3);
    await started;
    await settled();

    // Contiguous up to the present, never an opening with a hole in it.
    expect(stt.pushed.map((frame) => frame.chunk)).toEqual(
      frames(shed, PRE_ROLL_MAX_FRAMES + shed),
    );
    expect(traces.find(([step]) => step === 'pre-roll')?.[1]).toContain(`${shed} oldest shed`);
    // And the presenter is told, the same way as any other audio the
    // recogniser never received: those words will not be followed.
    expect(dropped).toEqual([shed]);
    await p.stop();
  });

  it('stays under the Rust session queue, which drops anything past 50 frames', () => {
    // `AUDIO_QUEUE_FRAMES` in src-tauri/src/speech/session.rs. The backlog is
    // pushed in one burst, so it must fit even if the worker has not taken a
    // single frame yet.
    expect(PRE_ROLL_MAX_FRAMES).toBeLessThan(50);
  });

  it('sends nothing it heard when the take is stopped during the load', async () => {
    const p = pipeline();
    const started = p.start();
    const load = await loading();

    speak(5);
    await p.stop();
    load.resolve(9);
    await expect(started).rejects.toThrow('SESSION_STOPPED');
    await settled();

    expect(stt.pushed).toEqual([]);
    // The session the load opened is still closed, not leaked.
    expect(stt.closed).toContain(9);
    expect(taps.every((tap) => tap.stopped)).toBe(true);
  });

  it('sends nothing it heard when the take is hard-paused during the load', async () => {
    const p = pipeline();
    const started = p.start();
    const load = await loading();

    speak(5);
    await p.hardPause();
    load.resolve(4);
    await expect(started).rejects.toThrow('SESSION_STOPPED');
    await settled();

    expect(stt.pushed).toEqual([]);
    expect(stt.closed).toContain(4);
  });

  it('carries nothing from a refused start into the next one', async () => {
    const p = pipeline();
    const refused = p.start();
    const load = await loading();

    speak(4);
    load.reject({ code: 'STT_MODEL_NOT_INSTALLED', userMessage: 'No model.' });
    await expect(refused).rejects.toMatchObject({ code: 'STT_MODEL_NOT_INSTALLED' });
    expect(taps[0].stopped, 'the tap opened for the refused start is closed').toBe(true);

    stt.load = null;
    const retried = p.start();
    const reload = await loading();
    speak(2);
    reload.resolve(12);
    await retried;
    await settled();

    expect(stt.pushed).toEqual([
      { generation: 12, chunk: 'frame-4' },
      { generation: 12, chunk: 'frame-5' },
    ]);
    await p.stop();
  });

  it('does not hold frames once the session is open', async () => {
    const p = pipeline();
    const started = p.start();
    (await loading()).resolve(2);
    await started;

    speak(3);
    await settled();
    expect(stt.pushed.map((frame) => frame.chunk)).toEqual(frames(0, 3));
    expect(traces).toContainEqual(['pre-roll', '0 frames held for the recogniser (0s)']);
    await p.stop();
  });
});
