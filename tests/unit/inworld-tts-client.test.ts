import { InworldTtsClient, type TtsFetch } from '@main/providers/inworld/tts-client';
import { pcm16ToWav, WAV_HEADER_BYTES } from '@main/providers/inworld/wav';
import { INWORLD_DEFAULTS } from '@shared/constants/runtime-defaults';
import { AppError } from '@shared/errors/app-error';
import type { TtsInput } from '@shared/contracts/adapters';

const SAMPLE_RATE = 24000;

/**
 * Build a mono WAV fixture with `numPcmBytes` of PCM payload — the shape Inworld
 * returns for `LINEAR16` (a complete RIFF/WAVE file, not raw samples).
 */
function wavFixture(numPcmBytes: number): Uint8Array {
  return pcm16ToWav(new Uint8Array(numPcmBytes).fill(7), SAMPLE_RATE, 1);
}

/**
 * A non-canonical WAV: a 12-byte `LIST` metadata chunk spliced in between `fmt `
 * and `data`, so the `data` chunk is no longer at the usual offset 36. Exercises
 * the chunk-walking passthrough against a layout `pcm16ToWav` never produces.
 */
function wavWithMetadataChunk(numPcmBytes: number): Uint8Array {
  const canonical = wavFixture(numPcmBytes);
  const list = new Uint8Array(12);
  list.set([0x4c, 0x49, 0x53, 0x54], 0); // 'LIST'
  new DataView(list.buffer).setUint32(4, 4, true); // chunk size = 4 (body left zero)
  const out = new Uint8Array(canonical.byteLength + list.byteLength);
  out.set(canonical.subarray(0, 36), 0); // 'RIFF'..end of fmt chunk
  out.set(list, 36);
  out.set(canonical.subarray(36), 36 + list.byteLength); // 'data' chunk onward
  new DataView(out.buffer).setUint32(4, out.byteLength - 8, true); // fix RIFF size
  return out;
}

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
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl: TtsFetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return jsonResponse({ audioContent: bytesToBase64(wavFixture(4)) });
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

  it('base64-decodes a WAV audioContent, passes it through, and computes duration', async () => {
    // 1 second of mono 16-bit PCM at SAMPLE_RATE, already wrapped as a WAV file
    // (the shape Inworld returns for LINEAR16).
    const wav = wavFixture(SAMPLE_RATE * 2);
    const fetchImpl: TtsFetch = async () =>
      jsonResponse(
        { audioContent: bytesToBase64(wav) },
        { headers: { 'x-request-id': 'req-42' } },
      );

    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    const result = await client.synthesize(ttsInput());

    expect(result.mimeType).toBe('audio/wav');
    expect(result.sampleRate).toBe(SAMPLE_RATE);
    expect(result.channels).toBe(1);
    // Passed through unchanged: same byte length as the fixture, with a single
    // RIFF/WAVE header (no second header nested inside).
    expect(result.bytes.byteLength).toBe(WAV_HEADER_BYTES + SAMPLE_RATE * 2);
    expect(Array.from(result.bytes.subarray(0, 4))).toEqual([0x52, 0x49, 0x46, 0x46]); // 'RIFF'
    expect(Array.from(result.bytes.subarray(8, 12))).toEqual([0x57, 0x41, 0x56, 0x45]); // 'WAVE'
    expect(result.durationMs).toBe(1000);
    expect(result.providerRequestId).toBe('req-42');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('passes a WAV audioContent through byte-for-byte (no double-wrap)', async () => {
    const wav = wavFixture(8);
    const fetchImpl: TtsFetch = async () => jsonResponse({ audioContent: bytesToBase64(wav) });
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    const result = await client.synthesize(ttsInput());
    expect(Array.from(result.bytes)).toEqual(Array.from(wav));
  });

  it('passes a non-canonical WAV (data not at offset 36) through byte-for-byte', async () => {
    // A LIST chunk before `data` pushes the payload off the canonical offset; the
    // adapter must still pass the bytes through and read duration from the chunks.
    const wav = wavWithMetadataChunk(SAMPLE_RATE * 2); // 1 s of audio
    const fetchImpl: TtsFetch = async () => jsonResponse({ audioContent: bytesToBase64(wav) });
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    const result = await client.synthesize(ttsInput());
    expect(Array.from(result.bytes)).toEqual(Array.from(wav));
    expect(result.durationMs).toBe(1000);
  });

  it('threads a custom modelId into the request body', async () => {
    let body: { modelId?: string } = {};
    const fetchImpl: TtsFetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ audioContent: bytesToBase64(wavFixture(2)) });
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

  it('throws TTS_FAILED when audioContent is not a valid WAV file', async () => {
    // Raw bytes with no RIFF/WAVE magic — e.g. headerless PCM the renderer can't
    // decode. The adapter must reject rather than hand back a corrupt clip.
    const fetchImpl: TtsFetch = async () =>
      jsonResponse({ audioContent: bytesToBase64(new Uint8Array([1, 2, 3, 4])) });
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    await expect(client.synthesize(ttsInput())).rejects.toMatchObject({
      code: 'TTS_FAILED',
    });
  });

  it('throws TTS_FAILED when the WAV header cannot be parsed', async () => {
    // Valid RIFF/WAVE magic but no fmt/data chunks -> wavDurationMs throws and the
    // adapter wraps it as TTS_FAILED.
    const broken = bytesToBase64(
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]),
    );
    const fetchImpl: TtsFetch = async () => jsonResponse({ audioContent: broken });
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
    const fetchImpl: TtsFetch = async () =>
      jsonResponse(
        { audioContent: bytesToBase64(wavFixture(4)) },
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

/** Build a streaming Response whose body emits `lines` as NDJSON bytes. */
function ndjsonResponse(
  lines: string[],
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  const text = lines.join('\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Emit in two arbitrary slices so the reader's line-buffering is exercised.
      const all = new TextEncoder().encode(text);
      const mid = Math.floor(all.byteLength / 2);
      controller.enqueue(all.subarray(0, mid));
      controller.enqueue(all.subarray(mid));
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init.headers),
    body,
  } as unknown as Response;
}

/** An NDJSON frame carrying a base64 WAV chunk, as Inworld `:stream` returns. */
function audioFrame(numPcmBytes: number): string {
  return JSON.stringify({ result: { audioContent: bytesToBase64(wavFixture(numPcmBytes)) } });
}

describe('InworldTtsClient.synthesizeStream', () => {
  it('emits each chunk as it arrives and returns the concatenated clip', async () => {
    let capturedUrl: string | undefined;
    const fetchImpl: TtsFetch = async (url) => {
      capturedUrl = String(url);
      return ndjsonResponse([
        audioFrame(40),
        JSON.stringify({ result: { usage: { processedCharactersCount: 5 } } }), // metadata-only
        audioFrame(60),
      ]);
    };
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });

    const chunks: number[] = [];
    const result = await client.synthesizeStream(ttsInput(), (chunk) => {
      chunks.push(chunk.bytes.byteLength);
    });

    // Hits the streaming endpoint.
    expect(capturedUrl).toBe('https://api.inworld.ai/tts/v1/voice:stream');
    // Two audio chunks (the metadata-only frame is skipped), each a full WAV.
    expect(chunks).toEqual([WAV_HEADER_BYTES + 40, WAV_HEADER_BYTES + 60]);
    // The returned clip concatenates both chunks' PCM into one WAV.
    expect(result.mimeType).toBe('audio/wav');
    expect(result.bytes.byteLength).toBe(WAV_HEADER_BYTES + 100);
  });

  it('throws TTS_FAILED on an error frame mid-stream', async () => {
    const fetchImpl: TtsFetch = async () =>
      ndjsonResponse([audioFrame(20), JSON.stringify({ error: { message: 'boom' } })]);
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    await expect(client.synthesizeStream(ttsInput(), () => {})).rejects.toMatchObject({
      code: 'TTS_FAILED',
    });
  });

  it('maps 401 to INWORLD_AUTH', async () => {
    const fetchImpl: TtsFetch = async () => ndjsonResponse([], { status: 401 });
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    await expect(client.synthesizeStream(ttsInput(), () => {})).rejects.toMatchObject({
      code: 'INWORLD_AUTH',
    });
  });

  it('throws TTS_FAILED when the stream yields no audio', async () => {
    const fetchImpl: TtsFetch = async () =>
      ndjsonResponse([JSON.stringify({ result: { usage: { processedCharactersCount: 0 } } })]);
    const client = new InworldTtsClient({ apiKey: 'k', fetchImpl });
    await expect(client.synthesizeStream(ttsInput(), () => {})).rejects.toMatchObject({
      code: 'TTS_FAILED',
    });
  });
});
