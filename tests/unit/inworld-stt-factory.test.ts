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

import { buildSttWsUrl, inworldWsConnect } from '@main/providers/factory';

/**
 * The Inworld streamBidirectional endpoint authenticates via a URL query
 * parameter (`?authorization=Basic%20<key>`), not an `Authorization` upgrade
 * header. These tests pin the encoding contract of buildSttWsUrl: the space
 * must be `%20` (not `+`), and a base64 credential's `+` `/` `=` must be
 * percent-escaped so the server reads the credential verbatim. Regression
 * guard for issue #10.
 */
describe('buildSttWsUrl', () => {
  const BASE = 'wss://example.com/stt/v1/transcribe:streamBidirectional';

  it('places the Basic credential in a lowercase `authorization` query param', () => {
    const url = buildSttWsUrl(BASE, 'abc123');
    expect(url).toBe(`${BASE}?authorization=Basic%20abc123`);
  });

  it('encodes the separating space as %20, never a `+`', () => {
    const url = buildSttWsUrl(BASE, 'abc123');
    expect(url).toContain('?authorization=Basic%20');
    // A `+` between "Basic" and the key would be decoded as a space only under
    // form-encoding semantics — the streaming endpoint reads the value verbatim.
    expect(url).not.toContain('Basic+');
  });

  it('percent-escapes base64 credential characters (+ / =)', () => {
    // A realistic base64 Basic credential containing every reserved char.
    const key = 'aGVsbG8+d29ybGQ/Zm9v==';
    const url = buildSttWsUrl(BASE, key);
    expect(url).toBe(`${BASE}?authorization=Basic%20aGVsbG8%2Bd29ybGQ%2FZm9v%3D%3D`);
    // No raw base64 reserved characters leak into the credential query value.
    const credentialValue = url.slice(`${BASE}?authorization=`.length);
    expect(credentialValue).not.toMatch(/[+/=]/);
  });

  it('round-trips back to the original credential when URL-decoded', () => {
    const key = 'aGVsbG8+d29ybGQ/Zm9v==';
    const url = buildSttWsUrl(BASE, key);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('authorization')).toBe(`Basic ${key}`);
  });

  it('appends with `&` when the base URL already carries a query string', () => {
    const url = buildSttWsUrl(`${BASE}?foo=bar`, 'abc123');
    expect(url).toBe(`${BASE}?foo=bar&authorization=Basic%20abc123`);
    expect(new URL(url).searchParams.get('authorization')).toBe('Basic abc123');
  });

  it('does not crash on an empty API key', () => {
    expect(buildSttWsUrl(BASE, '')).toBe(`${BASE}?authorization=Basic%20`);
  });
});

/**
 * Integration guard for the actual regression seam: `inworldWsConnect` must
 * open the socket with the query-param URL and pass NO options/headers argument.
 * The pure buildSttWsUrl tests above would still pass if line 47 were reverted
 * to the header form — this test is what catches that.
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

  it('opens the socket with a query-param URL and no Authorization header', async () => {
    const transport = await inworldWsConnect(
      { apiKey: 'abc123', model: 'inworld/inworld-stt-1', config },
      undefined,
    );

    expect(instances).toHaveLength(1);
    const ws = instances[0]!;
    expect(ws.url).toBe(
      'wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional?authorization=Basic%20abc123',
    );
    // The credential lives only in the URL — no second (options/headers) argument.
    expect(ws.options).toBeUndefined();

    transport.close();
  });
});
