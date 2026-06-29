// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListeningClipRef } from '@shared/contracts';
import { BackchannelPlayer } from '../../src/renderer/stage/playback/BackchannelPlayer';

// jsdom has no Web Audio. A minimal fake AudioContext lets us assert the
// player's control flow (resume-at-bootstrap, the play() guards, source wiring)
// without real audio decoding.

class FakeBufferSource {
  buffer: unknown = null;
  connectedTo: unknown = null;
  startedAt: number | null = null;
  connect(dest: unknown): void {
    this.connectedTo = dest;
  }
  start(when = 0): void {
    this.startedAt = when;
  }
}

let lastContext: FakeAudioContext | null = null;

class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  readonly destination = { id: 'destination' };
  resumeCalls = 0;
  closeCalls = 0;
  sources: FakeBufferSource[] = [];
  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
  }
  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }
  // Any non-empty fetched buffer decodes to a stand-in AudioBuffer.
  async decodeAudioData(bytes: ArrayBuffer): Promise<AudioBuffer> {
    if (bytes.byteLength === 0) {
      throw new Error('empty');
    }
    return { length: bytes.byteLength } as unknown as AudioBuffer;
  }
}

const clip = (id: string, ok = true): ListeningClipRef => ({
  clipId: id,
  // The fetch stub keys off the url: 'bad' clips fail to fetch.
  url: ok ? `candidcue://good/${id}` : `candidcue://bad/${id}`,
  durationMs: 800,
});

beforeEach(() => {
  lastContext = null;
  // A factory captures the constructed instance (returning an object from a
  // `new` call yields that object) so we avoid aliasing `this` in the fake.
  function FakeAudioContextCtor(): FakeAudioContext {
    const ctx = new FakeAudioContext();
    lastContext = ctx;
    return ctx;
  }
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContextCtor;
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async (url: string) => {
    if (url.includes('/bad/')) {
      throw new Error('network');
    }
    return { arrayBuffer: async () => new ArrayBuffer(16) } as Response;
  });
});

afterEach(() => {
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
});

describe('BackchannelPlayer', () => {
  it('resumes the context at bootstrap once clips are decoded (suspended → running)', async () => {
    const player = new BackchannelPlayer();
    expect(lastContext!.state).toBe('suspended');
    await player.init([clip('a')]);
    expect(lastContext!.resumeCalls).toBe(1);
    expect(lastContext!.state).toBe('running');
  });

  it('plays a decoded buffer when running and not speaking', async () => {
    const player = new BackchannelPlayer();
    await player.init([clip('a')]);
    player.play('thinking');
    expect(lastContext!.sources).toHaveLength(1);
    const source = lastContext!.sources[0]!;
    expect(source.buffer).not.toBeNull();
    expect(source.connectedTo).toBe(lastContext!.destination);
    expect(source.startedAt).toBe(0);
  });

  it('is a no-op when no clips were loaded (and never resumes)', async () => {
    const player = new BackchannelPlayer();
    await player.init([]);
    expect(lastContext!.resumeCalls).toBe(0);
    player.play('thinking');
    expect(lastContext!.sources).toHaveLength(0);
  });

  it('is a no-op while the stage is speaking (never talks over Mira)', async () => {
    const player = new BackchannelPlayer();
    await player.init([clip('a')]);
    player.play('speaking');
    expect(lastContext!.sources).toHaveLength(0);
  });

  it('is a no-op when the context is not running (suspended)', async () => {
    const player = new BackchannelPlayer();
    await player.init([clip('a')]);
    lastContext!.state = 'suspended'; // e.g. resume was rejected by autoplay policy
    player.play('thinking');
    expect(lastContext!.sources).toHaveLength(0);
  });

  it('is a no-op after dispose', async () => {
    const player = new BackchannelPlayer();
    await player.init([clip('a')]);
    await player.dispose();
    expect(lastContext!.closeCalls).toBe(1);
    player.play('thinking');
    expect(lastContext!.sources).toHaveLength(0);
  });

  it('skips clips that fail to fetch/decode and keeps the good ones', async () => {
    const player = new BackchannelPlayer();
    await player.init([clip('good'), clip('broken', false)]);
    // One good clip remains playable; the failed one was filtered out.
    player.play('thinking');
    expect(lastContext!.sources).toHaveLength(1);
  });

  it('does not retain buffers when disposed mid-decode', async () => {
    const player = new BackchannelPlayer();
    const pending = player.init([clip('a')]);
    await player.dispose(); // dispose races ahead of the decode completing
    await pending;
    player.play('thinking');
    expect(lastContext!.sources).toHaveLength(0);
  });
});
