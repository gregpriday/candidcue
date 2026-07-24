/**
 * §5.3 / §12.3. The attach seam.
 *
 * The important assertions are structural: the analyzer is handed a stream and
 * never acquires one, and the graph it builds is a sink. Both are properties
 * that are easy to break in a later refactor and impossible to notice from the
 * DSP tests.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachCoachingAnalyzer,
  decodeFrames,
  type AudioContextLike,
  type AudioNodeLike,
  type AudioWorkletNodeLike,
  type WorkletPortLike,
} from '../../../../src/shared/coaching/audio/worklet-node';
import {
  PACKED_FRAME_FIELDS,
  packFrame,
} from '../../../../src/shared/coaching/audio/frame-features';
import type { AudioFrameFeatures } from '../../../../src/shared/contracts/coaching';

const AUDIO_DIR = join(process.cwd(), 'src/shared/coaching/audio');

class FakePort implements WorkletPortLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: unknown[] = [];
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  deliver(message: unknown): void {
    this.onmessage?.({ data: message });
  }
}

interface FakeGraph {
  context: AudioContextLike;
  node: AudioWorkletNodeLike;
  port: FakePort;
  connections: string[];
  closed: { context: boolean };
  addedModules: string[];
}

function fakeGraph(): FakeGraph {
  const connections: string[] = [];
  const addedModules: string[] = [];
  const closed = { context: false };
  const port = new FakePort();

  const node: AudioWorkletNodeLike = {
    port,
    connect: (destination) => {
      connections.push(`node->${String(destination)}`);
      return destination;
    },
    disconnect: () => connections.push('node.disconnect'),
  };
  const source: AudioNodeLike = {
    connect: (destination) => {
      connections.push(destination === node ? 'source->node' : `source->${String(destination)}`);
      return destination;
    },
    disconnect: () => connections.push('source.disconnect'),
  };
  const context: AudioContextLike = {
    sampleRate: 48_000,
    audioWorklet: {
      addModule: async (url: string) => {
        addedModules.push(url);
      },
    },
    createMediaStreamSource: () => source,
    close: async () => {
      closed.context = true;
    },
  };
  return { context, node, port, connections, closed, addedModules };
}

async function attach(): Promise<{
  graph: Awaited<ReturnType<typeof attachCoachingAnalyzer>>;
  fake: FakeGraph;
  frames: AudioFrameFeatures[][];
}> {
  const fake = fakeGraph();
  const frames: AudioFrameFeatures[][] = [];
  const graph = await attachCoachingAnalyzer({
    stream: { getAudioTracks: () => [{}] },
    workletModuleUrl: '/assets/coaching-worklet.js',
    onFrames: (batch) => frames.push(batch),
    createContext: () => fake.context,
    createWorkletNode: () => fake.node,
  });
  return { graph, fake, frames };
}

describe('§5.3 one capture, multiple consumers', () => {
  it('never calls getUserMedia anywhere in the coaching audio package', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(AUDIO_DIR)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(join(AUDIO_DIR, file), 'utf8');
      // Prose in the module headers explains *why* there is no acquisition, so
      // only look at code: strip block comments and line comments first.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/getUserMedia|mediaDevices|requestMicrophoneAccess/.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('attaches to the stream it is handed', async () => {
    const { fake } = await attach();
    expect(fake.addedModules).toEqual(['/assets/coaching-worklet.js']);
    expect(fake.connections).toContain('source->node');
  });
});

describe('§12.3 the graph is a sink', () => {
  it('connects the source into the worklet and nothing onward', async () => {
    const { fake } = await attach();
    // Exactly one connection: source -> worklet node. Nothing reaches a
    // destination, so microphone audio cannot be routed to the speakers.
    expect(fake.connections).toEqual(['source->node']);
  });
});

describe('frame transport', () => {
  it('decodes published frames back into the contract shape', async () => {
    const { fake, frames } = await attach();
    const sample: AudioFrameFeatures = {
      audioTimeMs: 340,
      rmsDbfs: -21,
      peakDbfs: -9,
      clippingRatio: 0,
      noiseFloorDbfs: -55,
      estimatedSnrDb: 34,
      speechProbability: 0.91,
      voicedProbability: 0.77,
      f0Hz: 173.5,
      f0Confidence: 0.82,
      spectralFlux: 0.004,
      zeroCrossingRate: 0.031,
      processorDropout: false,
    };
    const packed = new Float64Array(PACKED_FRAME_FIELDS * 2);
    packFrame(packed, 0, sample);
    packFrame(packed, PACKED_FRAME_FIELDS, { ...sample, audioTimeMs: 360, f0Hz: null });

    fake.port.deliver({ type: 'frames', packed, frameCount: 2, sampleRate: 48_000 });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(2);
    expect((frames[0] as AudioFrameFeatures[])[0]).toEqual(sample);
    expect((frames[0] as AudioFrameFeatures[])[1]?.f0Hz).toBeNull();
  });

  it('decodeFrames is the inverse of packFrame for a batch', () => {
    const frame: AudioFrameFeatures = {
      audioTimeMs: 20,
      rmsDbfs: -30,
      peakDbfs: -12,
      clippingRatio: 0.5,
      noiseFloorDbfs: -60,
      estimatedSnrDb: 30,
      speechProbability: 1,
      voicedProbability: 0,
      f0Hz: null,
      f0Confidence: 0,
      spectralFlux: 0,
      zeroCrossingRate: 0,
      processorDropout: true,
    };
    const packed = new Float64Array(PACKED_FRAME_FIELDS);
    packFrame(packed, 0, frame);
    expect(decodeFrames(packed, 1)).toEqual([frame]);
  });
});

describe('§12.6 buffer commands', () => {
  it('sends a clear command with the reason', async () => {
    const { graph, fake } = await attach();
    graph.clearBuffer('application_lock');
    expect(fake.port.sent).toContainEqual({ type: 'clear_buffer', reason: 'application_lock' });
  });

  it('round-trips an extraction request', async () => {
    const { graph, fake } = await attach();
    const pending = graph.extract(1000, 1200);
    const request = fake.port.sent.at(-1) as { type: string; requestId: number };
    expect(request.type).toBe('extract');

    const pcm = new Float32Array([0.1, 0.2, 0.3]);
    fake.port.deliver({
      type: 'extracted',
      requestId: request.requestId,
      pcm,
      sampleRate: 48_000,
    });
    await expect(pending).resolves.toBe(pcm);
  });

  it('resolves an unanswered extraction as null on close instead of hanging', async () => {
    const { graph } = await attach();
    const pending = graph.extract(1000, 1200);
    await graph.close();
    await expect(pending).resolves.toBeNull();
  });

  it('close clears the buffer, tears the graph down and closes the context', async () => {
    const { graph, fake } = await attach();
    await graph.close();
    expect(fake.port.sent).toContainEqual({ type: 'clear_buffer', reason: 'microphone_stop' });
    expect(fake.connections).toContain('source.disconnect');
    expect(fake.connections).toContain('node.disconnect');
    expect(fake.closed.context).toBe(true);
  });
});
