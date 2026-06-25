import { InworldTtsClient, type TtsFetch } from '@main/providers/inworld/tts-client';
import { WAV_HEADER_BYTES } from '@main/providers/inworld/wav';
import { INWORLD_DEFAULTS } from '@shared/constants/runtime-defaults';
import { AppError } from '@shared/errors/app-error';
import type { TtsInput } from '@shared/contracts/adapters';

const SAMPLE_RATE = 24000;

/** A base {@link TtsInput} suitable for most cases; override per test. */
function ttsInput(overrides: Partial<TtsInput> = {}): TtsInput {
  return {
    text: 'Hello there.',
    voiceId: 'voice-1',
    style: 'neutral',
    speakingRate: 1,
    outputFormat: 'wav',
    sampleRate: SAMPLE_RATE,
    ...overrides,
  };
}

/** Encode raw bytes to a base64 string, mirroring the Inworld `audioContent`. */
function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Build a minimal Response-like object for a fake fetch. */
function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
  } as unknown as Response;
}

describe('InworldTtsClient', () => {
  it('posts to tts/v1/voice with Basic auth and the documented body', async () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl: TtsFetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return jsonResponse({ audioContent: bytesToBase64(pcm) });
    };

    const client = new InworldTtsClient({ apiKey: 'key-123', fetchImpl });
    await client.synthesize(ttsInput({ speakingRate: 1.1 }));

    expect(capturedUrl).toBe('https://api.inworld.ai/tts/v1/voice');
    expect(capturedInit?.method).toBe('POST');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Basic key-123');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Accept).toBeUndefined();

    const body = JSON.parse(String(capturedInit?.body));
    expect(body).toEqual({
      text: 'Hello there.',
      voiceId: 'voice-1',
      modelId: INWORLD_DEFAULTS.ttsModel,
      audioConfig: {
        audioEncoding: 'LINEAR16',
        sampleRateHertz: SAMPLE_RATE,
        speakingRate: 1.1,
      },
    });
    // outputFormat must not leak into the request body.
    expect(body.outputFormat).toBeUndefined();
  });

  it('base64-decodes audioContent, wraps to WAV, and computes duration', async () => {
    // 1 second of mono 16-bit PCM at SAMPLE_RATE.
    const pcm = new Uint8Array(SAMPLE_RATE * 2);
    pcm.fill(7);
    const fetchImpl: TtsFetch = async () =>
      jsonResponse(
        { audioContent: bytesToBase64(pcm) },
        { headers: { 'x-request-id': 'req-42' } },
      );

    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    const result = await client.synthesize(ttsInput());

    expect(result.mimeType).toBe('audio/wav');
    expect(result.sampleRate).toBe(SAMPLE_RATE);
    expect(result.channels).toBe(1);
    expect(result.bytes.byteLength).toBe(WAV_HEADER_BYTES + pcm.byteLength);
    expect(result.durationMs).toBe(1000);
    expect(result.providerRequestId).toBe('req-42');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('threads a custom modelId into the request body', async () => {
    let body: { modelId?: string } = {};
    const fetchImpl: TtsFetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ audioContent: bytesToBase64(new Uint8Array([0, 0])) });
    };
    const client = new InworldTtsClient({ apiKey: 'k', modelId: 'inworld-tts-custom', fetchImpl });
    await client.synthesize(ttsInput());
    expect(body.modelId).toBe('inworld-tts-custom');
  });

  it('throws TTS_FAILED when audioContent is missing', async () => {
    const fetchImpl: TtsFetch = async () => jsonResponse({ somethingElse: true });
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    await expect(client.synthesize(ttsInput())).rejects.toMatchObject({
      code: 'TTS_FAILED',
    });
  });

  it('throws TTS_FAILED when audioContent is an empty string', async () => {
    const fetchImpl: TtsFetch = async () => jsonResponse({ audioContent: '' });
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    await expect(client.synthesize(ttsInput())).rejects.toMatchObject({
      code: 'TTS_FAILED',
    });
  });

  it('throws TTS_FAILED when audioContent is whitespace-only', async () => {
    const fetchImpl: TtsFetch = async () => jsonResponse({ audioContent: '   ' });
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    await expect(client.synthesize(ttsInput())).rejects.toMatchObject({
      code: 'TTS_FAILED',
    });
  });

  it('throws TTS_FAILED when audioContent decodes to an odd byte length', async () => {
    // 3 bytes is not a whole number of 16-bit LINEAR16 samples.
    const fetchImpl: TtsFetch = async () =>
      jsonResponse({ audioContent: bytesToBase64(new Uint8Array([1, 2, 3])) });
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    await expect(client.synthesize(ttsInput())).rejects.toMatchObject({
      code: 'TTS_FAILED',
    });
  });

  it('throws TTS_FAILED (not a raw SyntaxError) when the OK body is invalid JSON', async () => {
    const fetchImpl: TtsFetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      }) as unknown as Response;
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    const rejection = client.synthesize(ttsInput());
    await expect(rejection).rejects.toBeInstanceOf(AppError);
    await expect(rejection).rejects.toMatchObject({ code: 'TTS_FAILED' });
  });

  it('rethrows an AbortError from json() unchanged', async () => {
    const fetchImpl: TtsFetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        },
      }) as unknown as Response;
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    await expect(client.synthesize(ttsInput())).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('falls back to x-inworld-request-id for providerRequestId', async () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl: TtsFetch = async () =>
      jsonResponse(
        { audioContent: bytesToBase64(pcm) },
        { headers: { 'x-inworld-request-id': 'inworld-req-7' } },
      );
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    const result = await client.synthesize(ttsInput());
    expect(result.providerRequestId).toBe('inworld-req-7');
  });

  it('classifies 401 as INWORLD_AUTH', async () => {
    const fetchImpl: TtsFetch = async () => jsonResponse({}, { status: 401 });
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    await expect(client.synthesize(ttsInput())).rejects.toMatchObject({
      code: 'INWORLD_AUTH',
    });
  });

  it('classifies 500 as TTS_FAILED', async () => {
    const fetchImpl: TtsFetch = async () => jsonResponse({}, { status: 500 });
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    await expect(client.synthesize(ttsInput())).rejects.toMatchObject({
      code: 'TTS_FAILED',
    });
  });
});
