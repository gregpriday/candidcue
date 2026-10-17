/**
 * The microphone test's transcription check against a push that stalls (#288).
 *
 * "Say something and watch the words appear" streams to the recogniser through
 * the same IPC push a take does, and it had the same unbounded chain in front
 * of it. Driven through the real facade with its Tauri-side edges doubled —
 * the event listener, the microphone, the PCM tap and the IPC wrappers — so
 * this proves the test's own queue is bounded and torn down with it. It does
 * not prove anything about a real bridge or a real microphone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Push {
  generation: number;
  chunk: string;
  settle(): void;
}

const stt = vi.hoisted(() => ({
  pushes: [] as Push[],
  settled: new Set<Push>(),
  closed: [] as number[],
}));

vi.mock('../../../src/control/services/ipc', async (original) => ({
  ...(await original<typeof import('../../../src/control/services/ipc')>()),
  isTauriRuntime: () => true,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}));

vi.mock('../../../src/control/services/stt/local', () => ({
  STT_EVENT: 'stt://event',
  encodePcm16: (samples: Float32Array) => `frame-${samples[0]}`,
  startTranscription: async () => 5,
  // Every push stalls: the bridge has wedged and nothing comes back.
  pushTranscriptionAudio: (generation: number, chunk: string) =>
    new Promise<void>((resolve) => {
      const push: Push = {
        generation,
        chunk,
        settle: () => {
          stt.settled.add(push);
          resolve();
        },
      };
      stt.pushes.push(push);
    }),
  stopTranscription: async (generation: number) => {
    stt.closed.push(generation);
  },
}));

const taps = vi.hoisted(() => [] as Array<{ onFrame: (samples: Float32Array) => void }>);

vi.mock('../../../src/control/services/audio/capture', () => ({
  PcmCapture: class {
    readonly onFrame: (samples: Float32Array) => void;
    constructor(options: { onFrame: (samples: Float32Array) => void }) {
      this.onFrame = options.onFrame;
      taps.push(this);
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
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
import { createRealVoiceFacade } from '../../../src/control/services/voice-live';

let spoken = 0;

function speak(count: number): void {
  const tap = taps.at(-1);
  if (!tap) throw new Error('no PCM tap is open');
  for (let i = 0; i < count; i += 1) {
    const samples = new Float32Array(2_400);
    samples[0] = spoken;
    spoken += 1;
    tap.onFrame(samples);
  }
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const errors: string[] = [];
const events = {
  onPartial: () => {},
  onFinal: () => {},
  onError: (message: string) => errors.push(message),
};

beforeEach(() => {
  stt.pushes.length = 0;
  stt.settled.clear();
  stt.closed.length = 0;
  taps.length = 0;
  traces.length = 0;
  errors.length = 0;
  spoken = 0;
  vi.stubGlobal('navigator', { mediaDevices: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the transcription check behind a stalled push', () => {
  it('holds a bounded backlog, traces what it sheds, and sends nothing after it stops', async () => {
    const stop = await createRealVoiceFacade().startTranscriptionTest(undefined, events);
    expect(errors, 'the check started cleanly').toEqual([]);

    const lost = 7;
    speak(1 + AUDIO_SEND_QUEUE_FRAMES + lost);
    // One call outstanding and nothing sent past it.
    expect(stt.pushes.map((push) => push.chunk)).toEqual(['frame-0']);
    expect(traces.some(([step]) => step === 'audio-dropped')).toBe(true);

    stop();
    stt.pushes[0]!.settle();
    await settled();
    expect(stt.pushes, 'the backlog belonged to a check that has ended').toHaveLength(1);
    expect(stt.closed).toEqual([5]);
  });

  it('keeps frames in order behind the call in flight', async () => {
    const stop = await createRealVoiceFacade().startTranscriptionTest(undefined, events);
    speak(3);
    stt.pushes[0]!.settle();
    await settled();
    expect(stt.pushes.map((push) => push.chunk)).toEqual(['frame-0', 'frame-1']);
    expect(new Set(stt.pushes.map((push) => push.generation))).toEqual(new Set([5]));
    stop();
  });
});
