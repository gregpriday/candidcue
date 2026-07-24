/**
 * §5.3/§12.1 wiring tests for the control-side coaching analyzer.
 *
 * These prove the parts no lane-level test can: that the analyzer decodes the
 * worklet's frames, and that the documented `GainNode(0)` keep-alive is
 * installed ONLY on evidence of silence — and, when installed, routes the
 * worklet node (never the microphone source) through a zero gain to the
 * destination. Every one is written to fail if the wiring is deleted.
 */
import { describe, it, expect, vi } from 'vitest';
import { startCoachingAnalyzer } from '../../../src/control/services/coaching-analyzer';
import { packFrame, PACKED_FRAME_FIELDS } from '../../../src/shared/coaching/audio/frame-features';
import type { AudioFrameFeatures } from '../../../src/shared/contracts/coaching';

function silentFrame(audioTimeMs: number): AudioFrameFeatures {
  return {
    audioTimeMs,
    rmsDbfs: -100,
    peakDbfs: -100,
    clippingRatio: 0,
    noiseFloorDbfs: -100,
    estimatedSnrDb: 0,
    speechProbability: 0,
    voicedProbability: 0,
    f0Hz: null,
    f0Confidence: 0,
    spectralFlux: 0,
    zeroCrossingRate: 0,
    processorDropout: false,
  };
}

function packFrames(frames: AudioFrameFeatures[]): Float64Array {
  const out = new Float64Array(frames.length * PACKED_FRAME_FIELDS);
  frames.forEach((frame, i) => packFrame(out, i * PACKED_FRAME_FIELDS, frame));
  return out;
}

/** A structural fake of the Web Audio surface the analyzer touches. */
function makeFakeContext() {
  const port: { onmessage: ((e: { data: unknown }) => void) | null; posted: unknown[] } = {
    onmessage: null,
    posted: [],
  };
  const node = {
    port: {
      get onmessage() {
        return port.onmessage;
      },
      set onmessage(fn: ((e: { data: unknown }) => void) | null) {
        port.onmessage = fn;
      },
      postMessage: (m: unknown) => port.posted.push(m),
    },
    connections: [] as unknown[],
    connect: (dest: unknown) => node.connections.push(dest),
    disconnect: () => {},
  };
  const gains: Array<{ input: unknown; connectedToDestination: boolean; gain: { value: number } }> = [];
  const destination = { id: 'destination' };
  const context = {
    sampleRate: 48000,
    currentTime: 0,
    destination,
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createMediaStreamSource: (_stream: unknown) => ({
      id: 'source',
      connect: () => {},
      disconnect: () => {},
    }),
    createGain: () => {
      const gain = {
        gain: { value: 1 },
        input: undefined as unknown,
        connectedToDestination: false,
        connect: (dest: unknown) => {
          if (dest === destination) gain.connectedToDestination = true;
        },
        disconnect: () => {},
      };
      gains.push(gain);
      return gain;
    },
    close: vi.fn(async () => {}),
    // The analyzer's node factory reads this off the context in test mode.
    createWorkletNodeForTest: () => {
      // Record what the keep-alive connects its input to.
      const original = node.connect;
      node.connect = (dest: unknown) => {
        if (gains.length > 0) {
          const gain = gains[gains.length - 1];
          if (gain) gain.input = node;
        }
        return original(dest);
      };
      return node;
    },
  };
  return { context, node, port, gains, destination };
}

const stream = {
  getAudioTracks: () => [{ kind: 'audio' }],
  getTracks: () => [{ kind: 'audio' }],
} as unknown as Parameters<typeof startCoachingAnalyzer>[0]['stream'];

describe('coaching analyzer — single-capture consumer wiring (§5.3)', () => {
  it('decodes worklet frames and forwards them, no keep-alive while they flow', async () => {
    const fake = makeFakeContext();
    const received: AudioFrameFeatures[] = [];
    const notices: string[] = [];

    const handle = await startCoachingAnalyzer({
      stream,
      workletModuleUrl: 'test://worklet',
      onFrames: (frames) => received.push(...frames),
      onNotice: (n) => notices.push(n),
      createContext: () => fake.context as never,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });

    const frames = [silentFrame(0), silentFrame(20)];
    fake.port.onmessage?.({ data: { type: 'frames', packed: packFrames(frames), frameCount: 2 } });

    // The frames reached the caller, decoded (proves the port → decode wiring).
    expect(received).toHaveLength(2);
    expect(received[0]?.audioTimeMs).toBe(0);
    expect(received[1]?.audioTimeMs).toBe(20);
    expect(handle.frameCount).toBe(2);
    // Frames flowed, so no keep-alive was ever installed.
    expect(handle.keepAliveInstalled).toBe(false);
    expect(notices).toContain('frames_flowing');
    expect(fake.gains).toHaveLength(0);

    await handle.close();
  });

  it('installs a GainNode(0) keep-alive only after the watchdog sees no frames', async () => {
    const fake = makeFakeContext();
    const notices: string[] = [];
    // Capture the watchdog callback and fire it by hand — deterministic silence.
    // A holder object avoids TS narrowing the captured callback back to `null`.
    const watchdog: { cb: (() => void) | null } = { cb: null };

    const handle = await startCoachingAnalyzer({
      stream,
      workletModuleUrl: 'test://worklet',
      onFrames: () => {},
      onNotice: (n) => notices.push(n),
      createContext: () => fake.context as never,
      setTimeoutFn: (cb) => {
        watchdog.cb = cb;
        return 1;
      },
      clearTimeoutFn: () => {},
    });

    // Before the watchdog fires: no keep-alive.
    expect(handle.keepAliveInstalled).toBe(false);

    // No frames arrived; fire the watchdog.
    watchdog.cb?.();

    expect(handle.keepAliveInstalled).toBe(true);
    expect(notices).toContain('no_frames_keepalive_installed');
    // Exactly one gain node, at zero gain, connected to the destination…
    expect(fake.gains).toHaveLength(1);
    const gain = fake.gains[0]!;
    expect(gain.gain.value).toBe(0);
    expect(gain.connectedToDestination).toBe(true);
    // …and fed by the WORKLET NODE, never the microphone source (§12.3): the
    // node writes only silence, so the speakers stay quiet by construction.
    expect(gain.input).toBe(fake.node);

    await handle.close();
  });

  it('reports attach_failed and rejects when addModule throws', async () => {
    const fake = makeFakeContext();
    fake.context.audioWorklet.addModule = vi.fn(async () => {
      throw new Error('addModule unsupported');
    });
    const notices: string[] = [];

    await expect(
      startCoachingAnalyzer({
        stream,
        workletModuleUrl: 'test://worklet',
        onFrames: () => {},
        onNotice: (n) => notices.push(n),
        createContext: () => fake.context as never,
        setTimeoutFn: () => 0,
        clearTimeoutFn: () => {},
      }),
    ).rejects.toThrow();
    expect(notices).toContain('attach_failed');
  });
});
