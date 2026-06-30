import type { SttSessionConfig } from '@shared/contracts/adapters';

interface FakeWsInstance {
  url: string;
  options: unknown;
  sent: string[];
  closed: boolean;
}

// Shared via vi.hoisted so the (hoisted) vi.mock factory can reach it without a
// temporal-dead-zone error on a module-body declaration.
const { instances } = vi.hoisted(() => ({ instances: [] as FakeWsInstance[] }));

/**
 * Minimal stand-in for the `ws` WebSocket: an EventEmitter (as the real one is)
 * that records its constructor arguments and auto-fires `open` on the next
 * microtask so `inworldWsConnect`'s connect promise resolves. Defined inside the
 * mock factory (with EventEmitter pulled in via dynamic import) so it is built
 * only when `ws` is actually imported — the hoisted factory cannot reference a
 * top-level import binding.
 */
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWs extends EventEmitter {
    static readonly OPEN = 1;
    readyState = FakeWs.OPEN;
    readonly url: string;
    readonly options: unknown;
    readonly sent: string[] = [];
    closed = false;

    constructor(url: string, options?: unknown) {
      super();
      this.url = url;
      this.options = options;
      instances.push(this);
      queueMicrotask(() => this.emit('open'));
    }

    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.closed = true;
    }
  }
  return { default: FakeWs };
});

import { inworldWsConnect } from '@main/providers/factory';

/**
 * The Inworld streamBidirectional endpoint authenticates via the standard
 * `Authorization: Basic <key>` upgrade header — verified against the live API.
 * The query-param scheme the rendered docs advertise
 * (`?authorization=Basic%20<key>`) is rejected live with SESSION_TOKEN_INVALID /
 * "authentication is required"; the header form returns real transcripts. These
 * tests are the regression guard for issue #10: the connect factory must open
 * the socket against the BARE endpoint URL and carry the credential in the
 * upgrade headers, never in the URL query string. The outbound first message is
 * the wrapped `transcribeConfig`, and audio frames are wrapped `audioChunk`s —
 * both confirmed live.
 */
describe('inworldWsConnect', () => {
  const config: SttSessionConfig = {
    sampleRate: 16000,
    channels: 1,
    model: 'inworld/inworld-stt-1',
    languageHint: 'en-US',
    interimResults: true,
  };

  beforeEach(() => {
    instances.length = 0;
  });

  it('opens the socket with an Authorization: Basic header and a bare URL', async () => {
    const transport = await inworldWsConnect(
      { apiKey: 'abc123', model: 'inworld/inworld-stt-1', config },
      undefined,
    );

    expect(instances).toHaveLength(1);
    const ws = instances[0]!;
    expect(ws.url).toBe('wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional');
    // The credential travels in the upgrade headers, NOT the URL query string.
    expect(ws.url).not.toContain('authorization=');
    expect(ws.options).toEqual({ headers: { Authorization: 'Basic abc123' } });

    transport.close();
  });

  it('sends the wrapped transcribeConfig as the first message', async () => {
    const transport = await inworldWsConnect(
      { apiKey: 'abc123', model: 'inworld/inworld-stt-1', config },
      undefined,
    );

    const ws = instances[0]!;
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      transcribeConfig: {
        modelId: 'inworld/inworld-stt-1',
        audioEncoding: 'LINEAR16',
        sampleRateHertz: 16000,
        numberOfChannels: 1,
        language: 'en-US',
      },
    });

    transport.close();
  });

  it('wraps outbound audio frames as base64 audioChunk messages', async () => {
    const transport = await inworldWsConnect(
      { apiKey: 'abc123', model: 'inworld/inworld-stt-1', config },
      undefined,
    );

    const ws = instances[0]!;
    const pcm = new Uint8Array([1, 2, 3, 4]).buffer;
    transport.send(pcm);
    // [0] is the transcribeConfig; [1] is the audio frame.
    expect(ws.sent).toHaveLength(2);
    expect(JSON.parse(ws.sent[1]!)).toEqual({
      audioChunk: { content: Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64') },
    });

    transport.close();
  });
});
